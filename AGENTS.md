## Project notes for agents

- Next.js 15 (App Router) + React 19 + TypeScript. Check `package.json` for the exact versions before relying on newer APIs.
- Docs: https://nextjs.org/docs (the installed `next` package does not ship local docs).
- Before finishing a change run: `npm run typecheck && npm run lint && npm test`.
- Format with `npm run format`. Do not commit `.env`; add new variables to `.env.example`.
