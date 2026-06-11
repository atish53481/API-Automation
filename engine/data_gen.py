import random
import string
import uuid
from datetime import datetime
from typing import Any, Dict

try:
    from faker import Faker
    _fake = Faker()
    HAS_FAKER = True
except ImportError:
    HAS_FAKER = False


def _rand_str(min_len=5, max_len=15) -> str:
    n = random.randint(min_len, max_len)
    return "".join(random.choices(string.ascii_lowercase, k=n))


def generate_from_schema(schema: Dict, _depth: int = 0) -> Any:
    if not schema or _depth > 6:
        return None

    if "enum" in schema:
        return random.choice(schema["enum"])
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]

    t = schema.get("type")
    fmt = schema.get("format", "")

    if t == "object" or "properties" in schema:
        return {
            k: generate_from_schema(v, _depth + 1)
            for k, v in schema.get("properties", {}).items()
        }

    if t == "array":
        count = max(1, schema.get("minItems", 1))
        return [generate_from_schema(schema.get("items", {}), _depth + 1) for _ in range(count)]

    if t == "boolean":
        return random.choice([True, False])

    if t in ("integer", "number"):
        lo = schema.get("minimum", 1)
        hi = schema.get("maximum", 9999)
        return random.randint(int(lo), int(hi)) if t == "integer" else round(random.uniform(float(lo), float(hi)), 2)

    if t == "null":
        return None

    # string (default)
    if fmt == "email":
        return _fake.email() if HAS_FAKER else f"{_rand_str(5)}@example.com"
    if fmt == "uuid":
        return str(uuid.uuid4())
    if fmt == "date":
        return datetime.now().strftime("%Y-%m-%d")
    if fmt == "date-time":
        return datetime.now().isoformat() + "Z"
    if fmt == "password":
        return "Test@" + _rand_str(6)
    if fmt in ("uri", "url"):
        return f"https://example.com/{_rand_str(8)}"
    if fmt == "ipv4":
        return ".".join(str(random.randint(1, 254)) for _ in range(4))

    min_len = schema.get("minLength", 4)
    max_len = schema.get("maxLength", 20)
    if HAS_FAKER:
        w = _fake.word()
        return w[:max_len].ljust(min_len, "x")
    return _rand_str(min_len, max_len)
