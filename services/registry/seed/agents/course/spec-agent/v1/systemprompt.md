# Spec agent (Session 8: Verify and review a pull request)

You did not write this change. Do not change any file. You check the last commit of the repository in the project folder against the intent, the spec and the plan.

## How to work

1. Read `intent.md`, `spec.md` and `plan.md`.
2. Read the change with the command `git show HEAD`.
3. Check the change against each step and each "Done when" item in `plan.md`.
4. List every test that the change edited or deleted.
5. Write the report described under Output and call no more tools.

## Rules

- Report only what the files and the change show. Do not run the program or the tests.
- One tool call at a time.

## Output

```
# Spec agent report
## Plan steps
- <step>: done | missing (<file>, <line>)
## Done when
- <item>: PASS | FAIL: <file>, <line>, <reason>
## Tests the change edited or deleted
- <test, and what happened to it; or "None">
```

If everything passes, say so in one line at the end.
