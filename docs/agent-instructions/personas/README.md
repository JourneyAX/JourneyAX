# PlaceMakers persona library

The owner's persona catalogue (43 personas, 86 use cases, 16 access roles, October 2026), read into one file the pack, the demo logins and the tests lean on.

| File | What it is | Edited by |
|---|---|---|
| `source/*.csv` | The owner's sheets, as given (personas, use cases, access model, ticketing tools) | replace with a newer export |
| `mapping.json` | The decisions that connect the sheets to the pack: which systems are ready / sample / pending, which team each staff persona is in, which access role each customer uses, which playbook serves which use case | by hand |
| `placemakers-personas.json` | The library: built from the two above, never edited by hand | `import-personas.ts` |
| `test-cases.json` | The small test set: a login, a question, and what the pack must allow, ask about or block | by hand |
| `TEST-CASES.md` | The same cases as a page to read and use | `import-personas.ts` |

## Refresh

```bash
npx tsx scripts/placemakers/import-personas.ts            # rebuild the library and TEST-CASES.md
npx tsx scripts/placemakers/import-personas.ts --check    # fail if either is out of date (writes nothing)
npx tsx scripts/placemakers/import-personas.ts --coverage-csv coverage.csv   # the one-row-per-use-case table
```

Running it twice changes nothing. The access-model sheet is the workbook sheet "ACCESS MODEL" saved as CSV (Excel: Save As CSV), because the importer reads CSV only:

```bash
python3 -c "import csv,openpyxl,sys;wb=openpyxl.load_workbook(sys.argv[1],read_only=True);csv.writer(open(sys.argv[3],'w',newline='')).writerows(wb[sys.argv[2]].iter_rows(values_only=True))" Book.xlsx "ACCESS MODEL" source/PlaceMakers_AccessModel.csv
```

## What it feeds

- **Demo logins** (`scripts/placemakers/demo-staff.ts`): each login names the persona it stands for; a test checks the team matches the catalogue.
- **The pack draft** (`docs/agent-instructions/placemakers-draft.json`): the Branch and Finance teams' connector rules, and seven staff playbooks (on-demand skills, access rows for staff groups only).
- **Tests** (`apps/project-service/test/personas-library.spec.ts`, `personas-cases.spec.ts`, `persona-access.spec.ts`).

The sheets say the personas and roles are proposed, not an export of real PlaceMakers logins.
