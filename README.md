# data-browser

A local database browser for people who need PostgreSQL or Linux. It uses the same layout and colors as Fairway and runs in the browser. You provide the connection. PostgreSQL, MySQL, and an existing SQLite file are supported. Credentials stay in the server process and are not saved to disk.

## Run

```sh
npm install
npm run dev
```

`npm run dev` starts the page and the API together. `npm start` does the same.

Open http://127.0.0.1:5173. The page is served by Vite and talks to an API on `127.0.0.1:3001`.

SQLite needs the path of an existing file. The server opens it with `better-sqlite3` and does not create a database file for you. Recent paths stay in this browser. Close releases the file. Backups are listed from `~/.data-browser/backups`. A SQLite copy opens by its path. A SQL snapshot can be imported into the selected PostgreSQL or MySQL database, or you can type the path of another SQL file. Reveal in folder shows that directory in the system file manager.

The browser can list schemas or databases, tables, and views; inspect columns, indexes, foreign keys, and table SQL; browse, sort, page, and edit rows; and run SQL. Cancel stops the current PostgreSQL or MySQL statement, and stops a SQLite statement by ending that query process. Completed statements stay committed. Destructive schema changes write a backup first.
