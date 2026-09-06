"""
Detection quality: mean average precision, per damage class.

The rule this module exists to enforce is that a detection number is
meaningless without three things attached to it:

    * which classes           — AP is reported per class, never only as a mean
    * which split             — named, and stored with the result
    * how big the split was   — images and ground-truth instances, per class

So `evaluate()` refuses to produce a headline figure without a split name,
and every payload it returns carries the sample size next to the score.
Nothing here invents data: with no predictions loaded, the app says the
model has not been evaluated, which is the honest state of a prototype
that measures growth rather than classifying damage.

Matching follows the standard PASCAL VOC / COCO protocol: greedy, highest
score first, one ground-truth box per prediction, IoU above threshold.
Average precision uses the 101-point interpolation COCO uses.
"""

RDD2022_CLASSES = {
    "D00": "Longitudinal crack",
    "D10": "Transverse crack",
    "D20": "Alligator cracking",
    "D40": "Pothole",
}

COCO_IOUS = [0.50 + 0.05 * i for i in range(10)]     # .50 : .05 : .95


def iou(box_a, box_b):
    """Intersection over union of two [x1, y1, x2, y2] boxes."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _average_precision(tp_flags, n_ground_truth):
    """
    101-point interpolated AP, plus the precision/recall curve behind it.

    `tp_flags` are 1/0 in descending score order.
    """
    if n_ground_truth == 0:
        return None, [], []
    tp = fp = 0
    precisions, recalls = [], []
    for flag in tp_flags:
        tp += flag
        fp += 1 - flag
        precisions.append(tp / float(tp + fp))
        recalls.append(tp / float(n_ground_truth))
    if not precisions:
        return 0.0, [], []

    # Make precision monotonically decreasing, then sample at 101 recalls.
    envelope = precisions[:]
    for i in range(len(envelope) - 2, -1, -1):
        envelope[i] = max(envelope[i], envelope[i + 1])

    total, cursor = 0.0, 0
    for step in range(101):
        target = step / 100.0
        while cursor < len(recalls) and recalls[cursor] < target:
            cursor += 1
        total += envelope[cursor] if cursor < len(envelope) else 0.0
    return total / 101.0, precisions, recalls


def _match_class(gt_items, pred_items, threshold):
    """Greedy match for one class at one IoU threshold -> tp flags."""
    by_image = {}
    for g in gt_items:
        by_image.setdefault(g["image_id"], []).append({"bbox": g["bbox"], "used": False})

    flags = []
    for p in sorted(pred_items, key=lambda x: -x.get("score", 0.0)):
        candidates = by_image.get(p["image_id"], [])
        best, best_iou = None, threshold
        for c in candidates:
            if c["used"]:
                continue
            value = iou(p["bbox"], c["bbox"])
            if value >= best_iou:
                best, best_iou = c, value
        if best is None:
            flags.append(0)
        else:
            best["used"] = True
            flags.append(1)
    return flags


def evaluate(ground_truth, predictions, split, model="", iou_main=0.5,
             class_names=None, notes=""):
    """
    Score a detector and return a payload the UI can show without editing.

    ground_truth : [{"image_id", "class", "bbox": [x1,y1,x2,y2]}, ...]
    predictions  : [{"image_id", "class", "bbox": [...], "score"}, ...]
    split        : the name of the test split, e.g. "RDD2022-India-val".
                   Required — a score with no split attached is not a result.
    """
    if not split or not str(split).strip():
        raise ValueError("A split name is required. A score without a named "
                         "split cannot be checked by anyone.")

    names = dict(RDD2022_CLASSES)
    names.update(class_names or {})

    classes = sorted({g["class"] for g in ground_truth} | {p["class"] for p in predictions})
    gt_images = {g["image_id"] for g in ground_truth}
    pred_images = {p["image_id"] for p in predictions}

    per_class, ap_main, ap_coco = [], [], []
    for cls in classes:
        gt_items = [g for g in ground_truth if g["class"] == cls]
        pred_items = [p for p in predictions if p["class"] == cls]
        n_gt = len(gt_items)

        flags = _match_class(gt_items, pred_items, iou_main)
        ap, precisions, recalls = _average_precision(flags, n_gt)

        # AP averaged over the COCO IoU sweep, for the stricter headline.
        sweep = [_average_precision(_match_class(gt_items, pred_items, t), n_gt)[0]
                 for t in COCO_IOUS]
        sweep = [v for v in sweep if v is not None]
        ap_sweep = sum(sweep) / len(sweep) if sweep else None

        best_f1 = best_p = best_r = 0.0
        for p_val, r_val in zip(precisions, recalls):
            if p_val + r_val > 0:
                f1 = 2 * p_val * r_val / (p_val + r_val)
                if f1 > best_f1:
                    best_f1, best_p, best_r = f1, p_val, r_val

        per_class.append({
            "class": cls,
            "name": names.get(cls, cls),
            "gt_instances": n_gt,
            "gt_images": len({g["image_id"] for g in gt_items}),
            "predictions": len(pred_items),
            "ap": None if ap is None else round(ap, 4),
            "ap_iou_sweep": None if ap_sweep is None else round(ap_sweep, 4),
            "best_f1": round(best_f1, 4),
            "precision_at_best_f1": round(best_p, 4),
            "recall_at_best_f1": round(best_r, 4),
        })
        if ap is not None:
            ap_main.append(ap)
        if ap_sweep is not None:
            ap_coco.append(ap_sweep)

    return {
        "split": str(split).strip(),
        "model": model or "unnamed model",
        "notes": notes,
        "iou_threshold": iou_main,
        "sample": {
            "images_in_split": len(gt_images | pred_images),
            "images_with_ground_truth": len(gt_images),
            "ground_truth_instances": len(ground_truth),
            "predictions": len(predictions),
            "classes": len(classes),
        },
        "map": round(sum(ap_main) / len(ap_main), 4) if ap_main else None,
        "map_iou_sweep": round(sum(ap_coco) / len(ap_coco), 4) if ap_coco else None,
        "per_class": per_class,
    }


# ---------------------------------------------------------------------------
#  Loaders
# ---------------------------------------------------------------------------
def load_voc_xml(directory, image_ids=None):
    """
    Read Pascal VOC annotation XML — the format RDD2022 ships in.

    Returns the same list of dicts `evaluate()` takes, so the day a real
    detector exists its output can be scored against the public labels
    without touching this file.
    """
    import os
    import xml.etree.ElementTree as ET

    items = []
    for name in sorted(os.listdir(directory)):
        if not name.lower().endswith(".xml"):
            continue
        image_id = os.path.splitext(name)[0]
        if image_ids is not None and image_id not in image_ids:
            continue
        root = ET.parse(os.path.join(directory, name)).getroot()
        for obj in root.findall("object"):
            label = (obj.findtext("name") or "").strip()
            box = obj.find("bndbox")
            if not label or box is None:
                continue
            try:
                items.append({
                    "image_id": image_id,
                    "class": label,
                    "bbox": [float(box.findtext("xmin")), float(box.findtext("ymin")),
                             float(box.findtext("xmax")), float(box.findtext("ymax"))],
                })
            except (TypeError, ValueError):
                continue
    return items


def load_json(path):
    """Read a detection file: a bare list, or {"annotations"/"detections": [...]}."""
    import json
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        for key in ("annotations", "detections", "predictions", "items"):
            if key in data:
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError("Expected a list of detections in %s" % path)
    out = []
    for row in data:
        bbox = row.get("bbox") or row.get("box")
        if bbox and len(bbox) == 4:
            out.append({
                "image_id": str(row.get("image_id") or row.get("image") or row.get("file")),
                "class": str(row.get("class") or row.get("category") or row.get("label")),
                "bbox": [float(v) for v in bbox],
                "score": float(row.get("score", row.get("confidence", 1.0))),
            })
    return out
