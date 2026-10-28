.PHONY: dev backend frontend test image

# Back (:8080) e front (:5173) juntos, com recarregamento. Ctrl+C encerra os dois.
dev:
	@trap 'kill 0' INT TERM; \
	(cd backend && go run ./cmd/server) & \
	(cd frontend && npm run dev) & \
	wait

backend:
	cd backend && go run ./cmd/server

frontend:
	cd frontend && npm run dev

test:
	cd backend && go vet ./... && go test -race ./...
	cd frontend && npm run build && npm run lint

image:
	docker build -t discordia .
