SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

TEST_SCRIPTS := $(wildcard tests/*.sh)

.PHONY: check
check: $(TEST_SCRIPTS)
	@if [ -z "$(TEST_SCRIPTS)" ]; then \
		echo "No test scripts found in tests/"; \
		exit 1; \
	fi
	@fail=0; \
	for t in $(TEST_SCRIPTS); do \
		echo "--- Running $$t ---"; \
		bash "$$t" || fail=1; \
	done; \
	if [ "$$fail" -ne 0 ]; then \
		echo "FAIL: some tests failed"; \
		exit 1; \
	fi
	@echo "All tests passed."
