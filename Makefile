# Thin front for bin/install, which holds the actual installation logic so that
# the same steps stay usable without make.

PREFIX ?= $(HOME)/.local
NAME := confluence-companion

.PHONY: help install dev-install bundle test update uninstall

help:
	@echo "make install      Build, install, and register $(NAME) with OpenCode"
	@echo "make dev-install  Reinstall and register without reinstalling dependencies"
	@echo "make update       git pull, then reinstall"
	@echo "make bundle       Build the single-file bundle into dist/"
	@echo "make test         Build and run the unit tests"
	@echo "make uninstall    Remove the installed command, keeping credentials"

install:
	@PREFIX="$(PREFIX)" bin/install

dev-install:
	@PREFIX="$(PREFIX)" bin/install --no-deps

bundle:
	npm run bundle

test:
	npm test

update:
	git pull --ff-only
	@PREFIX="$(PREFIX)" bin/install

uninstall:
	rm -f "$(PREFIX)/bin/$(NAME)"
	@echo "Removed $(PREFIX)/bin/$(NAME)."
	@echo "Credentials in ~/.config/$(NAME)/config.env were kept; delete that file to remove them."
