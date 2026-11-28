"""Read displayable fields from model JSON while it is still arriving."""
import json

try:
    from backend.ppt_document import COLOR_PATTERN, MAX_ELEMENTS, element
except ModuleNotFoundError:
    from ppt_document import COLOR_PATTERN, MAX_ELEMENTS, element


class PptPreview:
    """Track JSON strings and containers across arbitrary provider chunk boundaries.

    Only validated, complete elements are previewed. Full document validation
    and settlement take place separately after the upstream stream finishes.
    """

    def __init__(self, kind):
        self.kind = kind
        self.source = ""
        self.stack = []
        self.string_start = None
        self.escaped = False
        self.previous = None
        self.key = None
        self.emitted = 0
        self.has_text = False
        self.background = None
        self.element_ids = set()

    def string_update(self, end, complete):
        role = self.stack[-1][0] if self.stack else None
        value_field = self.key if self.previous == ":" else None
        visible = ((role in ("root", "outline_page") and value_field == "title")
                   or (role == "outline_page" and value_field == "brief")
                   or (role in ("element", "edit") and value_field == "text"))
        if not visible and not complete:
            return
        # An escape or high surrogate may straddle two provider fragments.
        try:
            value = json.loads(self.source[self.string_start:end] + '"')
        except ValueError:
            return
        if visible:
            if value and 0xD800 <= ord(value[-1]) <= 0xDBFF:
                value = value[:-1]
            text = value[self.emitted:]
            if text:
                prefix = "\n" if self.has_text and not self.emitted else ""
                self.has_text = True
                self.emitted = len(value)
                yield {"type": "progress", "text": prefix + text.encode("utf-8", "replace").decode()}
        elif complete and self.previous != ":":
            self.key = value
        elif role == "root" and value_field == "background" and COLOR_PATTERN.fullmatch(value):
            self.background = value

    def feed(self, chunk):
        start = len(self.source)
        self.source += chunk
        for offset, char in enumerate(chunk, start):
            if self.string_start is not None:
                if self.escaped:
                    self.escaped = False
                elif char == "\\":
                    self.escaped = True
                elif char == '"':
                    yield from self.string_update(offset, True)
                    self.string_start = None
                    self.previous = "string"
                continue
            if char.isspace():
                continue
            if char == '"':
                self.string_start = offset
                self.emitted = 0
                continue
            if char in "[{":
                parent = self.stack[-1][0] if self.stack else None
                role = None
                if not self.stack and char == "{":
                    role = "root"
                elif parent == "root" and char == "[" and self.previous == ":":
                    if self.kind == "page" and self.key == "elements":
                        role = "elements"
                    elif self.kind == "outline" and self.key == "slides":
                        role = "slides"
                    elif self.kind == "original_edit" and self.key == "edits":
                        role = "edits"
                elif parent == "elements" and char == "{":
                    role = "element"
                elif parent == "slides" and char == "{":
                    role = "outline_page"
                elif parent == "edits" and char == "{":
                    role = "edit"
                self.stack.append((role, offset))
            elif char in "]}" and self.stack:
                role, pos = self.stack.pop()
                if role == "element" and len(self.element_ids) < MAX_ELEMENTS:
                    try:
                        obj = element(json.loads(self.source[pos:offset+1]), {})
                    except (ValueError, TypeError, RecursionError):
                        pass
                    else:
                        if obj["id"] not in self.element_ids:
                            self.element_ids.add(obj["id"])
                            yield {"type": "element", "element": obj, "background": self.background}
            self.previous = char
        if self.string_start is not None:
            yield from self.string_update(len(self.source), False)
