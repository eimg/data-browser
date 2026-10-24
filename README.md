# data-browser

A local database browser that runs in the browser. You provide the connection. PostgreSQL, MySQL, and SQLite are supported. Credentials stay in the server process and are not saved to disk.

## Run

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. The page is served by Vite and talks to an API on `127.0.0.1:3001`.

SQLite needs the path of an existing file. The server opens it with `better-sqlite3` and does not create a database file for you.

## This pass

Connecting, reading the server or file version, and disconnecting. The API keeps a Drizzle client for the open session so later browsing can share one driver layer across PostgreSQL, MySQL, and SQLite.
