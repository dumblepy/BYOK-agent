exec:
	docker compose start app
	docker compose exec app bash

diff:
	git diff --cached > .diff
