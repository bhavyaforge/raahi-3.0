# What is in here

Everything in this folder came out of the app. Nothing was mocked up, drawn by
hand, or edited afterwards.

```
docs/
├── screenshots/     the app running, one image per screen
├── sample-run/      one crack, eighteen photographs — the input and the output
├── walkthrough/     the presentation guide, as a PDF and as a web page
└── defence/         the technical document: every algorithm and constant, defended
```

---

## screenshots/

Taken from a live browser against a real server, on the eighteen-day demo round.

| file | what it shows |
| --- | --- |
| `00-overview.jpg` | What the build does, and the four limits it states up front |
| `01-capture-batch.jpg` | Eighteen photographs uploading in order, with the GPS panel filled in |
| `01-gps-from-a-phone.jpg` | A phone photograph's own EXIF, read out in full |
| `01-gallery.jpg` | Every photograph in the record, each removable on its own |
| `03-growth.jpg` | The seal light, and day 1 against day 18 |
| `03-growth-curve.jpg` | Eighteen readings climbing toward the 150 mm threshold |
| `03-signal-seal-it.jpg` | Red — crossing the threshold, with the date |
| `03-signal-holding.jpg` | Green — measured twice, not growing |
| `04-seal-list.jpg` | The ranked list: growth × rain × traffic, every term shown |
| `05-report-the-formula.jpg` | The formula worked out term by term |
| `05-report-every-pass.jpg` | All eighteen passes with position and match reasoning |
| `06-detection-quality.jpg` | The deliberately empty page, and why it is empty |

---

## sample-run/

One crack, photographed eighteen mornings. Both halves are here — what went in,
and what the app made of it — so the loop can be checked without running
anything.

| file | what it is |
| --- | --- |
| `day01.png` `day09.png` `day18.png` | Three of the eighteen input photographs. Real EXIF: GPS, heading, capture date, focal length. Open one in any EXIF viewer. |
| `report.json` | `GET /api/report/SITE-001` — detect, track, predict, schedule, verify, and every pass |
| `seal-list.json` | `GET /api/schedule` — the ranked list with each term of the formula |
| `risk.json` | `GET /api/risk` — the formula's working, its terms, and its stated assumptions |

**The figures that run produced:**

```
18 readings over 17 days      110.1 mm  ->  134.3 mm      (+24.2 mm)
growth        1.392 mm/day    R² 0.974
lead time     28.3 days       first sighting to predicted failure
formula       1.392 mm/day × 2.17 rain × 1.00 traffic = 3.016 mm/day effective
priority      77  URGENT
seal by       12 September    (18 September in dry weather — the rain costs 6 days)
verify        ON TREND        last pass gained 1.4 mm against an expected 1.4
```

Every one of the seventeen revisits was matched by the app itself, and each
explains why. This is pass two:

> 1.2 m from the recorded position; camera pointing within 4 deg of before;
> scene matches (1/64 bits differ)

### Reproduce it

```bash
python3 raahi.py demo      # writes the same eighteen photographs
python3 raahi.py           # then upload them all at once on the CAPTURE tab
```

The figures will differ slightly: the rainfall term comes from the monthly
normal for the month you run it in, so a January run scores far lower than a
September one — correctly, because nothing is coming to get into the crack.

---

## walkthrough/

`Reading-the-RAAHI-Prototype.pdf` — sixteen pages, A4, fonts embedded. Every
tab explained, what each number means, why it is there, how it compares to a
survey van or a complaint app, and the questions to expect with answers ready.

`reading-the-raahi-prototype.html` is the same content as a web page.

---

## defence/

`RAAHI-Technical-Defence.pdf` — thirty-five pages, A4, fonts embedded. The
walkthrough explains what the screens say; this explains what the code does.

Nine parts, written for the reviewer who does not take a claim on trust:

| part | what it settles |
| --- | --- |
| 1 | The claim, in one page |
| 2 | Image processing — threshold sweep, morphological opening, connected components, the four shape gates, and the false positives it is honest about |
| 3 | GPS — the EXIF tags byte by byte, reading them, writing them, and why position alone is never allowed to decide that two photographs are the same crack |
| 4 | Pixels into millimetres — the pinhole model, the four-rung fallback ladder, the bias-cancellation argument, and the error budget |
| 5 | Growth — least squares, R², the confidence interval on the slope, and how a rate becomes a date |
| 6 | The priority formula, term by term, with every assumption named |
| 7 | The backend — one upload traced through twenty steps, the schema, content-addressed storage, and the endpoint table |
| 8 | What changes between this laptop and a truck: motion blur, bandwidth, retention, DPDP |
| 9 | Fifty questions with answers ready, the hostile ones included |

`raahi-technical-defence.html` is the same content as a web page.

---

## What is deliberately *not* in here

**`data/` — the runtime record.** The SQLite file and the stored photographs
from a demo run are not committed, and the `.gitignore` keeps them out.

That is not tidiness. The app's central claim is that **nothing is preloaded**:
every figure on screen came from photographs taken on that machine. Ship a
filled database in the repository and a fresh clone would show eighteen
readings before anyone had uploaded anything — which would quietly make the
claim false, and a judge who cloned the repo would find that out.

The demo photographs are generated on demand by `python3 raahi.py demo`, so
they are not committed either. Three of them are here as samples, which is
enough to inspect the EXIF without carrying all eighteen in version control.
