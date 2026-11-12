"""Separate Vercel's matched rewrite parameter from application query input."""
from flask import request


def application_query():
    args = request.args.copy()
    # /api/:path* -> /api/index.py appends its captured path in production.
    # Ignore only an exact match, never arbitrary/duplicate path arguments.
    if args.getlist("path") == [request.path.removeprefix("/api/")]:
        args.pop("path")
    return args
