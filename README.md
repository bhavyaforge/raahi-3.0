# RAAHI — crack growth prototype

**Team Innovators · SIH26198**

Photograph a crack. The app measures it, records where the photo was taken, and
recognises that spot again the next time somebody stands there. Once the same
crack has been photographed twice it has a growth rate — and a date by which it
needs sealing.

Nothing to install. Python's standard library only.

```bash
cd ~/Desktop/raahi
python3 server.py
```

The browser opens at <http://localhost:8000>. Stop it with `Control + C`.

---

## What is new in this build

### 1. GPS out of the photograph itself

Drop a photo taken on a phone onto the CAPTURE tab and the backend reads its
EXIF block: latitude, longitude, altitude, the compass heading the camera was
pointing, the stated GPS accuracy, the moment the shutter fired, and the lens
focal length. Those numbers appear under **WHERE THIS PHOTO WAS TAKEN**, with a
link that opens the exact position on a map.

JPEG, HEIC and PNG (`eXIf` chunk) are all read. When a photo carries no
position — a webcam frame, a screenshot, a file whose metadata was stripped —
the browser's own geolocation is used instead, and the panel says which of the
two it was. Nothing is guessed silently.

### 2. Knowing it is the same spot tomorrow

This is the question the whole project rests on, and GPS alone cannot answer
it: a phone fixes its position to about 5–10 m, and two cracks 4 m apart are
different cracks. So three independent signals are combined in
`raahi_backend/geo.py`:

| signal | what it rules out | tolerance |
| --- | --- | --- |
| **Distance** — haversine between the two fixes | a different street | 15 m |
| **Heading** — GPS image direction | standing in one place, photographing two different edges of the road | 45° |
| **Appearance** — a 64-bit difference hash of the picture | everything else, and it works with no GPS at all | 12 of 64 bits |

A photo is the same spot when position **and** heading agree, or when the scene
is unmistakable on its own (7 bits or fewer). Position agreeing while the scene
disagrees is not silently accepted — the app says so and offers a manual
override, because a road looks different wet and that must not break the record.

Every match is explained in plain words: *"4.9 m from the recorded position;
camera pointing within 4 deg of before; scene matches (5/64 bits differ)"*.
Each further visit re-centres the spot on the average of its own fixes, so
tomorrow's match is tighter than today's.

### 3. Lead time

**Lead time is the number of days between the day a crack was first seen and
the day it is predicted to cross the sealing threshold.** It appears on the
SEAL LIST tab and per spot on GROWTH.

It only exists if somebody photographs the same square metre of road more than
once, which is why no Indian road authority reports it today. It is computed
honestly: a least-squares fit over the readings actually stored, with the fit
quality (R²) printed beside it, and a warning on the face of it when the fit is
loose. A spot with one photograph gets no rate and therefore no date — it sits
at the bottom of the list rather than being given an invented one.

### 4. A baseline to measure against

The GROWTH tab opens with the **baseline** — the first photograph of that spot —
next to the latest one, both full size, with the difference in millimetres
between them. Under it, every pass as a thumbnail with its length and date.

Growth is the number the app sells, and the reason is on the OVERVIEW tab:
absolute length carries a small constant bias, because a thick stroke's outline
adds its own width. In a subtraction a constant bias cancels exactly.

### 5. Detection quality — mAP per damage class

The DETECTION QUALITY tab reports average precision **per damage class**, on a
**named test split**, with the **sample size** — images and ground-truth
instances — printed next to every score. `raahi_backend/metrics.py` refuses to
produce a headline figure without a split name.

Until a real model is scored against real labels the tab stays empty and says
so, because this build measures crack growth and does not classify damage. To
score one:

```bash
python3 tools/eval_map.py \
    --gt   labels/rdd2022_india_val_xml \
    --pred runs/yolov8s_predictions.json \
    --split RDD2022-India-val \
    --model "YOLOv8s 640px, 60 epochs" \
    --post http://localhost:8000
```

`--gt` takes a Pascal VOC XML directory (the format RDD2022 ships in) or JSON;
`--pred` takes JSON with a score on every box. `--post` publishes the result
into the running app. Matching follows the standard VOC/COCO protocol, and both
AP@0.5 and AP@[.50:.95] are reported per class.

A worked example is in `tools/sample_eval/` — run it to see the output format
before you have a model.

### 6. Calibration is out of the user's way

Somebody photographing a road should not be asked to calibrate anything. They
see two buttons: **Upload photo** and **Capture photo**.

Millimetres are worked out on the server, from the best source available:

1. a calibration measured for that specific spot, if one exists;
2. the global calibration from the training tab, rescaled automatically if this
   photo is a different pixel width than the one it was measured on;
3. **the lens itself** — a 35 mm-equivalent focal length implies a 36 mm-wide
   frame, so focal length and shooting distance alone give millimetres per
   pixel with no reference object at all.

The calibration screen still exists, and it is unchanged in substance — it just
lives on the **TRAINING** tab, hidden until you click *training tools* in the
footer or open `?training=1`. Accuracy trials against a ruler and detector
scoring live there too.

---

## The tabs

| tab | what it is for |
| --- | --- |
| **00 OVERVIEW** | What this build does, what it does not, and where the data lives |
| **01 CAPTURE** | Upload or take a photo; measurement, position and spot match |
| **02 SPOTS** | Every place photographed, baseline and latest side by side |
| **03 GROWTH** | Baseline against latest, the curve, the verdict, the lead time |
| **04 SEAL LIST** | Ranked by time remaining, built only from real readings |
| **05 DETECTION QUALITY** | mAP per class on a named split, or an honest blank |
| **06 TRAINING** | Calibration, ruler trials, detector scoring — hidden by default |

---

## Try it without leaving the room

```bash
python3 tools/make_demo_photos.py --out demo_photos --passes 5
```

This writes five PNGs of a crack that grows a little each day, each carrying a
real EXIF block — GPS position jittered by a few metres exactly as a real fix
would be, capture date, camera heading, focal length. Upload them in order on
the CAPTURE tab.

Nothing is preloaded into the database. The app reads their EXIF, works out on
its own that they are the same spot, and builds the growth curve and the lead
time from them.

---

## Check that it all still works

```bash
python3 tools/selftest.py
```

Starts the server, writes real geotagged photographs, uploads them over HTTP,
and asserts 29 things about what comes back: that GPS is read from the file,
that later passes land on the same spot, that a photo 12 km away does not, that
the growth rate is positive, that a one-photo spot gets no invented date, that
an unnamed split is refused, that a 100 mm reference measures 100 mm, and that a
deleted spot's id is never handed to a different spot. Nothing is mocked.

---

## Layout

```
raahi/
├── server.py                  the whole server: static files + JSON API
├── raahi_backend/
│   ├── exif.py                EXIF/GPS from JPEG, HEIC and PNG
│   ├── geo.py                 distance, heading, scene hash, revisit decision
│   ├── growth.py              least-squares growth rate, lead time, verdicts
│   ├── metrics.py             AP per class, COCO IoU sweep, VOC XML loader
│   ├── store.py               SQLite + the original photos
│   └── api.py                 the endpoints
├── web/
│   ├── index.html
│   ├── styles.css
│   └── app.js                 crack detection in the browser
├── tools/
│   ├── eval_map.py            score a detector from the command line
│   ├── make_demo_photos.py    geotagged demo photographs
│   ├── selftest.py            end-to-end check
│   └── sample_eval/           the JSON format, worked through
└── data/                      created on first run — SQLite + photos
```

`data/` is not committed. Delete it to start clean; copy it to move the whole
record to another machine.

## API

| method | path | what it does |
| --- | --- | --- |
| GET | `/api/state` | counts, calibration, fleet lead time |
| GET | `/api/sites` | every spot with its growth report |
| GET | `/api/sites/<id>` | one spot, with every observation |
| GET | `/api/schedule` | the ranked seal list and the lead-time summary |
| GET | `/api/metrics/detection` | the latest per-class mAP, or an honest blank |
| GET | `/photo/<sha>` | the original photograph, as uploaded |
| POST | `/api/observations` | a photo plus what the browser measured in it |
| POST | `/api/calibration` | training only |
| POST | `/api/threshold` | change the seal threshold |
| POST | `/api/metrics/detection` | score a detector |
| POST | `/api/trials` | record an accuracy trial against a ruler |
| DELETE | `/api/sites/<id>`, `/api/observations/<id>`, `/api/trials` | |

Everything runs on localhost. No external calls, no dependencies, no data
leaves the machine.

## Limits, stated plainly

* No trained damage classifier. Detection is thresholding, morphology and
  connected components — not a model. The RDD2022 class labels on the seal list
  come from whoever typed them.
* No detection score to quote yet. The published reference point is CRDDC'2022,
  best team F1 0.769 on RDD2022 — that is what we are aiming at, not our result.
* Runs on a laptop or a phone browser, not on a truck.
* Daylight, close range, camera roughly overhead. Not heavy rain.
* Absolute length carries a small constant bias. Growth is a subtraction, so
  the bias cancels — that is why growth is the number reported.

## Camera notes

The camera needs the local server: run `python3 server.py` and use
`http://localhost:8000`, not a `file://` path. Uploading a photo works either
way — and an uploaded phone photo carries GPS, which a webcam frame does not.
