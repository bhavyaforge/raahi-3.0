"""
RAAHI backend.

    exif      read GPS and lens data out of a photograph
    geotag    write GPS into a photograph, the way a shutter does
    geo       decide whether today's photo is yesterday's crack
    growth    turn readings into a rate, a date and a lead time
    rainfall  what rain is coming — the second term of the formula
    traffic   what load the road carries — the third term
    risk      growth rate x rainfall x traffic, the seal list's order
    metrics   score a detector, per class, on a named split
    store     the record: SQLite and the original photos
    api       the JSON the browser talks to
"""

__all__ = ["exif", "geotag", "geo", "growth", "rainfall", "traffic", "risk",
           "metrics", "store", "api"]
