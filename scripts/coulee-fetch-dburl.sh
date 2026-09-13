#!/bin/sh
# Print DATABASE_URL to stdout with a marker so we can extract it cleanly.
printf 'FLYURL=<<%s>>\n' "${DATABASE_URL:-MISSING}"
