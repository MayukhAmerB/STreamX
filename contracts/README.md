# API Contract

`openapi.yaml` is generated from Django and committed as the backend/frontend
contract. Regenerate it with `npm run contract:generate` from the repository
root. CI fails when generated schema or TypeScript types drift from Git.
