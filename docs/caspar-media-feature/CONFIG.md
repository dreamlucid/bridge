# CasparCG config mapping

The caspar media plugin reads the same `<paths>` section that media-scanner uses (see media-scanner `src/config.ts`).

## XML → internal keys

Each child of `<paths>` uses the prefix before the first `-` in the tag name:

| XML element | Resolved key | Upload target name |
|-------------|--------------|--------------------|
| `media-path` | `media` | **Media** |
| `template-path` | `template` | **Template** |
| `font-path` | `font` | **Font** |
| `log-path` | `log` | Not used for upload (MVP) |
| `data-path` | `data` | Not used for upload (MVP) |

## Example fragment

```xml
<configuration>
    <paths>
        <media-path>/opt/caspar/media/</media-path>
        <template-path>/opt/caspar/template/</template-path>
        <font-path>/opt/caspar/font/</font-path>
        <log-path disable="false">/opt/caspar/log/</log-path>
        <data-path>/opt/caspar/data/</data-path>
    </paths>
    ...
</configuration>
```

## Relative paths

If a path in XML is relative, it is resolved relative to the **directory containing** `casparcg.config` (same idea as running tools from a known config location).

## Font default

If `font-path` is omitted, media-scanner’s nconf default is effectively `./font` relative to process cwd. The plugin uses **`font` as a subdirectory next to `casparcg.config`** only when that directory exists at save time, so optional font upload stays predictable without depending on Bridge’s cwd.

## Requirements for a successful save

- `media-path` and `template-path` must be present in `<paths>` and must resolve to existing directories (after resolution).
- `font` appears in `resolvedRoots` only when taken from XML or when the default `…/font` beside the config file exists.
