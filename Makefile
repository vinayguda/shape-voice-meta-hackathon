.PHONY: dev check

# One command. Demo mode needs no API key. Requires Node 20+.
dev:
	node server/index.js

check:
	node scripts/walkthrough.js
