"""Turns a captured photo into the small, text-only form Power BI can display.

Same recipe as the Fabric notebook that loads photos into the Lakehouse table
dim_money_mapping_image_chunks: shrink to 500px, JPEG quality 80, base64
data-URI, then split into 7,500-character pieces (the SQL endpoint caps a text
value at 8,000). A Power BI measure joins a capture's pieces back together in
CHUNK_INDEX order. Keep these constants in step with that notebook so one
measure works for both tables.
"""
import base64
import io

from PIL import Image, ImageOps

MAX_PX = 500
QUALITY = 80
CHUNK = 7500
PREFIX = "data:image/jpeg;base64,"


def build_chunks(image_bytes: bytes) -> list:
    """Raises ValueError if the bytes aren't a readable image."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((MAX_PX, MAX_PX))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=QUALITY, optimize=True)
    except Exception as e:
        raise ValueError(f"photo could not be read as an image ({type(e).__name__})") from e
    data_uri = PREFIX + base64.b64encode(buf.getvalue()).decode()
    return [data_uri[i:i + CHUNK] for i in range(0, len(data_uri), CHUNK)]
