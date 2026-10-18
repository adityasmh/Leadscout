# Do-not-call exports (operator-provided)

This folder is where the operator places the official **do-not-call (DND)** exports that
Leadscout screens leads against before a number reaches a caller's sheet.

## Where to put the files

Put one or more files in this folder (`data/dnd/`) with a `.csv`
extension. Every `.csv` file in the folder is read. The folder can be overridden per run
by the caller of the gate (`ctx.dndDir`); the default is this folder.

## One-column CSV format

Each file is a plain one-column CSV: **one phone number per line**, nothing else.

```
9876543210
+91 98765 43210
022-2345-6789
```

- The first column is the only column read; extra columns are ignored.
- A header row is allowed and is skipped automatically when it is not a number.
- Blank lines and lines starting with `#` are ignored.
- Numbers are normalised the same way as lead phones (the shared verifier's
  `classifyPhone`: `+91` Indian mobile / landline, generic E.164, else digits).
- If the folder has no `.csv` file, no number can be screened and every lead is tagged
  `dnd-unchecked` on the call sheet so the caller knows the screen was not run.

## How to get the data

The operator supplies the official registry export (for India, the TRAI DND registry
export; for other countries, the equivalent national do-not-call register). Convert it to
the one-column CSV above and drop it here.

**Leadscout never calls the number registry itself.** It only reads the file(s) you place
in this folder. If you do not provide a file, nothing is screened (`dnd-unchecked`).
