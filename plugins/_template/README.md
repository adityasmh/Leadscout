# Plugin template

Copy-paste starter for a Leadscout channel plugin.

```bash
cp -r plugins/_template plugins/my-plugin
```

1. Edit `plugin.json` (id must equal the folder name, lowercase-with-hyphens).
2. Rename `example-channel.ts` and edit the adapter: id, categories, parsing, `status()` flag.
3. Update `index.ts` to import your adapter file(s).
4. Copy the check, point it at your fixtures, run it:
   `LEADSCOUT_PLUGINS=my-plugin npx tsx plugins/my-plugin/example-channel-check.ts`
5. Enable it for real: `LEADSCOUT_PLUGINS=my-plugin` plus your channel flag in `.env`.
6. Write down in your plugin README what the target site's terms allow.

The full contract and house rules are in [`plugins/README.md`](../README.md).
