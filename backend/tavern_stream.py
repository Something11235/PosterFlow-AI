"""Wire framing for incremental tavern replies; never forward raw provider events."""
import codecs
import io
import json

from flask import Response, jsonify


class IncompleteStream(ValueError):
    """The provider didn't deliver a complete chat completion."""


def sse_data(chunks):
    # UTF-8 characters, CRLF pairs, and event boundaries can all span reads.
    decoder = io.IncrementalNewlineDecoder(codecs.getincrementaldecoder("utf-8-sig")(), translate=True)
    line_parts, fields = [], []

    def lines():
        for chunk in chunks:
            segments = decoder.decode(chunk).split("\n")
            line_parts.append(segments[0])
            for segment in segments[1:]:
                yield "".join(line_parts)
                line_parts[:] = [segment]
        tail = decoder.decode(b"", final=True)
        if tail.endswith("\n"):
            yield "".join(line_parts) + tail[:-1]

    for line in lines():
        if not line:
            if fields:
                yield "\n".join(fields)
                fields.clear()
        elif line.startswith("data:"):
            fields.append(line[5:].removeprefix(" "))
        elif line.startswith(":"):
            yield None  # a content-free keepalive


def completion_deltas(chunks, normalize_usage, max_chars, invalid_content, *, structured=False):
    text, size = [], 0
    final_usage = None
    finished_choice = False
    finish_reason = None
    refused = False
    for event in sse_data(chunks):
        if event is None:
            yield None
            continue
        if event == "[DONE]":
            break
        frame = json.loads(event)
        if not isinstance(frame, dict) or frame.get("error") is not None:
            raise IncompleteStream()
        choices = frame.get("choices")
        if not isinstance(choices, list):
            raise IncompleteStream()
        for choice in choices:
            if not isinstance(choice, dict):
                raise IncompleteStream()
            if choice.get("index", 0) != 0:
                continue
            delta = choice.get("delta")
            if delta is None and choice.get("finish_reason") is not None:
                delta = {}
            if not isinstance(delta, dict):
                raise IncompleteStream()
            if structured and (delta.get("refusal") or choice.get("finish_reason") == "content_filter"):
                refused = True
            fragment = delta.get("content")
            if fragment is not None and not isinstance(fragment, str):
                raise IncompleteStream()
            if fragment:
                fragment.encode("utf-8")
                # A counter received before further output is not a final bill.
                final_usage = None
                finished_choice = False
                size += len(fragment)
                if size <= max_chars and not refused:
                    text.append(fragment)
                    yield fragment
            if choice.get("finish_reason") is not None:
                finished_choice = True
                finish_reason = choice["finish_reason"]
                if frame.get("usage") is not None:
                    final_usage = frame["usage"]
        # include_usage sends the aggregate after the last choice, before DONE.
        if not choices and frame.get("usage") is not None:
            final_usage = frame["usage"]
            # This is the protocol's final accounting record, sent after the
            # assistant choice has finished. Losing the following DONE marker
            # must not discard a complete reply and its actual bill.
            if finished_choice and normalize_usage(final_usage)["status"] == "confirmed":
                break
    else:
        # Some compatible providers attach the final counts to the terminal
        # choice itself and cleanly close without a separate DONE message.
        explicit_stop = structured and (refused or finish_reason == "length")
        if not finished_choice or (not explicit_stop and normalize_usage(final_usage)["status"] != "confirmed"):
            raise IncompleteStream()
    content = "".join(text)
    usage = normalize_usage(final_usage)
    if structured and (refused or finish_reason == "length"):
        return {"content": content if not refused and size <= max_chars else "", "usage": usage, "streaming": True,
                "finish_reason": "content_filter" if refused else "length"}
    if not content.strip() or size > max_chars:
        raise invalid_content(usage)
    return {"content": content, "usage": usage, "streaming": True}


def run_without_deltas(work):
    try:
        next(work)
    except StopIteration as completed:
        return completed.value
    finally:
        work.close()
    raise RuntimeError("unexpected delta in a non-streaming request")


def stream_response(work, error_payload, finish_on_disconnect, *, delta_packet=None, result_packet=None):
    # Start the upstream while Flask still handles HTTP errors normally. A
    # provider returning ordinary JSON (or an idempotent replay) needs no stream.
    try:
        first = next(work)
    except StopIteration as completed:
        return jsonify(completed.value)

    def encode(packet):
        return (json.dumps(packet, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")

    closed = False
    def close():
        nonlocal closed
        if closed:
            return
        closed = True
        try:
            if finish_on_disconnect:
                # The upstream POST has already happened. Drain that exact
                # response, including usage, within its original deadline so
                # settlement/recovery do not depend on an open browser tab.
                for _ in work:
                    pass
        except Exception:
            # The billing path has already recorded/attempted the same outcome
            # it would have delivered in an error frame to a connected client.
            pass
        finally:
            work.close()

    def events():
        try:
            delta = first
            while True:
                yield b"\n" if delta is None else encode(
                    delta_packet(delta) if delta_packet else {"type": "delta", "text": delta})
                try:
                    delta = next(work)
                except StopIteration as completed:
                    yield encode(result_packet(completed.value) if result_packet else {"type": "done", **completed.value})
                    return
                except Exception as error:
                    yield encode({"type": "error", **error_payload(error)})
                    return
        finally:
            # Some WSGI servers discard their iterable on a broken socket
            # before they reach Response.close(). Finalize here as well.
            close()

    response = Response(events(), mimetype="application/x-ndjson",
                        headers={"X-Accel-Buffering": "no", "Vary": "Accept"})
    response.call_on_close(close)
    return response
