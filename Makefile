SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

TEST_SCRIPTS := $(wildcard tests/*.sh)

.PHONY: check check-e2e check-vm

# Fast smoke tests — every tests/*.sh script. If ALL the servers used by the
# e2e scenario are on PATH, run the e2e scenario too.
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
	@if command -v fs-fallback >/dev/null 2>&1 \
	   && command -v nix-dev-exec >/dev/null 2>&1 \
	   && command -v pnpm-wrapper >/dev/null 2>&1 \
	   && command -v docs-fetcher >/dev/null 2>&1; then \
		echo "--- Running end-to-end scenario ---"; \
		bash tests/scenarios/end-to-end.sh || exit 1; \
	else \
		echo "SKIP: e2e scenario (some server binaries missing)"; \
	fi
	@echo "All tests passed."

# Explicit end-to-end scenario. Assumes devShell binaries on PATH.
check-e2e:
	@bash tests/scenarios/end-to-end.sh

# NixOS VM integration test. Requires KVM on the host.
check-vm:
	@nix build .#checks.$$(nix eval --raw --impure --expr 'builtins.currentSystem').vm-integration -L
