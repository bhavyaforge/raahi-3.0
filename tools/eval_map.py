#!/usr/bin/env python3
"""
Score a damage detector and publish the result into the app.

    python3 tools/eval_map.py \
        --gt   labels/rdd2022_india_val_xml \
        --pred runs/yolo_v8s_predictions.json \
        --split RDD2022-India-val \
        --model "YOLOv8s 640px, 60 epochs"

  --gt    a directory of Pascal VOC XML (the format RDD2022 ships in),
          or a JSON file of ground-truth boxes
  --pred  a JSON file of predicted boxes with scores

JSON rows look like:

    {"image_id": "India_000123", "class": "D00",
     "bbox": [x1, y1, x2, y2], "score": 0.87}

The split name is required. A detection score without a named split and a
stated sample size cannot be checked by anyone, so this tool will not
produce one.

With --post the result is stored in the running app and appears on the
DETECTION QUALITY tab; without it, the numbers are printed and nothing is
written.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from raahi_backend import metrics


def load_side(path, kind):
    if os.path.isdir(path):
        if kind == "predictions":
            raise SystemExit("Predictions must be a JSON file, not a directory.")
        return metrics.load_voc_xml(path)
    if not os.path.isfile(path):
        raise SystemExit("No such file: %s" % path)
    return metrics.load_json(path)


def print_report(report):
    sample = report["sample"]
    print()
    print("  SPLIT      %s" % report["split"])
    print("  MODEL      %s" % report["model"])
    print("  SAMPLE     %d images, %d ground-truth instances, %d predictions"
          % (sample["images_with_ground_truth"], sample["ground_truth_instances"],
             sample["predictions"]))
    print("  IoU        %.2f for the per-class AP; sweep is .50:.05:.95" % report["iou_threshold"])
    print()
    print("  %-6s %-22s %8s %8s %9s %8s %8s" %
          ("CLASS", "NAME", "AP@.5", "AP.5:.95", "GT INST", "PREDS", "BEST F1"))
    print("  " + "-" * 74)
    for row in report["per_class"]:
        print("  %-6s %-22s %8s %8s %9d %8d %8s" % (
            row["class"], row["name"][:22],
            "n/a" if row["ap"] is None else "%.3f" % row["ap"],
            "n/a" if row["ap_iou_sweep"] is None else "%.3f" % row["ap_iou_sweep"],
            row["gt_instances"], row["predictions"], "%.3f" % row["best_f1"]))
    print("  " + "-" * 74)
    print("  %-29s %8s %8s" % (
        "mAP",
        "n/a" if report["map"] is None else "%.3f" % report["map"],
        "n/a" if report["map_iou_sweep"] is None else "%.3f" % report["map_iou_sweep"]))
    print()
    print("  Quote it as: mAP@0.5 = %s on %s (%d images, %d instances)." % (
        "n/a" if report["map"] is None else "%.3f" % report["map"],
        report["split"], sample["images_with_ground_truth"],
        sample["ground_truth_instances"]))
    print()


def main():
    parser = argparse.ArgumentParser(description="Per-class mAP for road damage detection.")
    parser.add_argument("--gt", required=True, help="VOC XML directory or JSON of ground truth")
    parser.add_argument("--pred", required=True, help="JSON of predictions with scores")
    parser.add_argument("--split", required=True, help="name of the test split")
    parser.add_argument("--model", default="", help="what produced the predictions")
    parser.add_argument("--iou", type=float, default=0.5, help="IoU for the headline AP")
    parser.add_argument("--notes", default="", help="anything a reader should know")
    parser.add_argument("--json-out", default="", help="also write the payload here")
    parser.add_argument("--post", default="", metavar="URL",
                        help="publish to a running app, e.g. http://localhost:8000")
    args = parser.parse_args()

    ground_truth = load_side(args.gt, "ground truth")
    predictions = load_side(args.pred, "predictions")
    if not ground_truth:
        raise SystemExit("The ground truth is empty — there is nothing to score against.")

    report = metrics.evaluate(ground_truth, predictions, split=args.split,
                              model=args.model, iou_main=args.iou, notes=args.notes)
    print_report(report)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print("  Written to %s" % args.json_out)

    if args.post:
        body = json.dumps({
            "split": args.split, "model": args.model, "iou": args.iou,
            "notes": args.notes, "ground_truth": ground_truth, "predictions": predictions,
        }).encode("utf-8")
        request = urllib.request.Request(
            args.post.rstrip("/") + "/api/metrics/detection", data=body,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                json.load(response)
            print("  Published to %s — see the DETECTION QUALITY tab." % args.post)
        except urllib.error.URLError as err:
            print("  Could not reach %s (%s). Is the server running?" % (args.post, err))


if __name__ == "__main__":
    main()
