# Changelog

## 0.2.0 - 2026-08-28

- Added an IndexedDB-backed infinite canvas with local image import, gallery handoff, layout tools, and PNG export.
- Added AI image frames for seven common aspect ratios and in-place generated-image replacement.
- Added annotation redraw with large red arrows and text, automatic nearby-annotation detection, and recognized text extraction.
- Added a no-cost preflight preview showing the clean reference, annotated reference, recognized instructions, and compressed sizes.
- Switched reference editing to OpenAI-compatible multipart `/v1/images/edits` requests with single and multi-image support.
- Added browser-side reference resizing and compression for Vercel request limits, plus backend validation and regression tests.
- Changed the local Flask development default to `127.0.0.1`; public container deployment remains handled by Gunicorn.

## 0.1.0 - 2026-08-13

- Added browser-side provider configuration for OpenRouter and custom OpenAI-compatible relays.
- Replaced the poster-only Brief workflow with a general preset library and editable prompt workflow.
- Added eight built-in image categories plus custom preset cover upload, edit, delete, JSON import, and JSON export.
- Added independent text/image generation and previous-image local redraw behavior.
- Removed embedded API keys and added environment-based server defaults.
- Added endpoint, private-network, upload-size, and generation-parameter validation.
- Added Docker deployment and GitHub Actions verification.
- Organized legacy scripts, design documents, screenshots, and local review artifacts.
