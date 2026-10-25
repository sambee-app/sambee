+++
title = "Syntax Highlighting Languages"
+++

Sambee shares language highlighting across text viewing and editing, Markdown source, and code blocks in Markdown previews. Language selection depends on where you're working:

- **Text files:** The file's extension selects the language. Files with unmatched extensions use plain text. In some cases like `Dockerfile`, the full filename is used for language selection.
- **Markdown code blocks:** A shortcode after the opening code fence selects the language, such as `py` for Python. Shortcodes aren't case-sensitive. Unlabelled or unknown labels use plain text.

For which files Sambee can open, see [Supported File Formats](../supported-file-formats/).

## Markdown: Choose a Code Block Language

Put a shortcode immediately after the opening three backticks:

````markdown
```py
def greet(name):
	return f"Hello, {name}!"
```
````

Shortcodes on the same row select the same language; for example, `py` and `python` both select Python. Sambee reads only the first whitespace-separated word after the opening fence.

Use `text`, `txt`, `plaintext`, `plain`, or `none` to explicitly request plain text. Very large blocks can remain plain text without losing their contents.

## Languages, Extensions, and Shortcodes

The file column lists extensions and special filename matches. Special filenames take priority over extensions; their case rules vary. For example, `Dockerfile` requires that spelling, while `nginx.conf` matches in any case. **None** means there's no automatic file match or accepted Markdown shortcode for that entry.

| Language or format | File extensions or names | Markdown shortcodes |
|---|---|---|
| Angular Template | None | None |
| APL | `.dyalog`, `.apl` | `apl` |
| ASN.1 | `.asn`, `.asn1` | `asn.1` |
| Asterisk | `extensions.conf` | `asterisk` |
| Brainfuck | `.b`, `.bf` | `brainfuck` |
| C | `.c`, `.h`, `.ino` | `c` |
| C# | `.cs` | `cs`, `csharp`, `c#` |
| C++ | `.cpp`, `.c++`, `.cc`, `.cxx`, `.hpp`, `.h++`, `.hh`, `.hxx` | `cpp`, `c++` |
| Clojure | `.clj`, `.cljc`, `.cljx` | `clojure` |
| ClojureScript | `.cljs` | `clojurescript` |
| Closure Stylesheets (GSS) | `.gss` | None |
| CMake | `.cmake`, `CMakeLists.txt` | `cmake` |
| COBOL | `.cob`, `.cpy` | `cobol` |
| CoffeeScript | `.coffee` | `coffee`, `coffee-script`, `coffeescript` |
| Common Lisp | `.cl`, `.lisp`, `.el` | `lisp` |
| CQL (Cassandra) | `.cql` | `cql`, `cassandra` |
| Crystal | `.cr` | `crystal` |
| CSS | `.css` | `css` |
| Cypher | `.cyp`, `.cypher` | `cypher` |
| Cython | `.pyx`, `.pxd`, `.pxi` | `cython` |
| D | `.d` | `d` |
| Dart | `.dart` | `dart` |
| Diff | `.diff`, `.patch` | `diff` |
| Dockerfile | `Dockerfile` | `docker`, `dockerfile` |
| DTD | `.dtd` | `dtd` |
| Dylan | `.dylan`, `.dyl`, `.intr` | `dylan` |
| EBNF | None | `ebnf` |
| ECL | `.ecl` | `ecl` |
| edn | `.edn` | `edn` |
| Eiffel | `.e` | `eiffel` |
| Elm | `.elm` | `elm` |
| Erlang | `.erl` | `erlang` |
| Esper | None | `esper` |
| F# | `.fs` | `fsharp`, `f#` |
| Factor | `.factor` | `factor` |
| FCL | None | `fcl` |
| Forth | `.forth`, `.fth`, `.4th` | `forth` |
| Fortran | `.f`, `.for`, `.f77`, `.f90`, `.f95` | `fortran` |
| Gas (GNU assembler) | `.s` | `gas` |
| Gherkin | `.feature` | `gherkin` |
| Go | `.go` | `go` |
| Groovy | `.groovy`, `.gradle`, `Jenkinsfile` | `groovy` |
| Haskell | `.hs` | `haskell` |
| Haxe | `.hx` | `haxe` |
| HTML | `.html`, `.htm`, `.handlebars`, `.hbs` | `html`, `htm`, `xhtml` |
| HTTP | None | `http` |
| HXML | `.hxml` | `hxml` |
| IDL | `.pro` | `idl` |
| Java | `.java` | `java` |
| JavaScript | `.js`, `.mjs`, `.cjs` | `js`, `javascript`, `ecmascript`, `node` |
| Jinja | `.j2`, `.jinja`, `.jinja2` | `jinja` |
| JSON | `.json`, `.map` | `json`, `json5` |
| JSON-LD | `.jsonld` | `jsonld`, `json-ld` |
| JSX | `.jsx` | `jsx` |
| Julia | `.jl` | `julia` |
| Kotlin | `.kt`, `.kts` | `kt`, `kotlin` |
| LaTeX | `.text`, `.ltx`, `.tex` | `tex`, `latex` |
| LESS | `.less` | `less` |
| Liquid | `.liquid` | `liquid` |
| LiveScript | `.ls` | `ls`, `livescript` |
| Lua | `.lua` | `lua` |
| MariaDB SQL | None | `mariadb` |
| Markdown | `.md`, `.markdown`, `.mkd` | `md`, `markdown` |
| Mathematica | `.m`, `.nb`, `.wl`, `.wls` | `mathematica` |
| Mbox | `.mbox` | `mbox` |
| mIRC | `.mrc` | `mirc` |
| Modelica | `.mo` | `modelica` |
| MS SQL | None | `mssql` |
| MscGen | `.mscgen`, `.mscin`, `.msc` | `mscgen` |
| MsGenny | `.msgenny` | `msgenny` |
| MUMPS | `.mps` | `mumps` |
| MySQL | None | `mysql` |
| Nginx | Names ending in `.conf` that contain `nginx`, such as `nginx.conf` | `nginx` |
| NSIS | `.nsh`, `.nsi` | `nsis` |
| NTriples | `.nt`, `.nq` | `ntriples` |
| Objective-C | None | `objective-c`, `objc` |
| Objective-C++ | `.mm` | `objective-c++`, `objc++` |
| OCaml | `.ml`, `.mli`, `.mll`, `.mly` | `ocaml` |
| Octave | None | `octave` |
| Oz | `.oz` | `oz` |
| Pascal | `.p`, `.pas` | `pascal` |
| Perl | `.pl`, `.pm` | `perl` |
| PGP | `.asc`, `.pgp`, `.sig` | `pgp`, `asciiarmor` |
| PHP | `.php`, `.php3`, `.php4`, `.php5`, `.php7`, `.phtml` | `php` |
| Pig | `.pig` | `pig` |
| PLSQL | `.pls` | `plsql` |
| PostgreSQL | None | `postgresql` |
| PowerShell | `.ps1`, `.psd1`, `.psm1` | `ps1`, `powershell` |
| Properties files | `.properties`, `.ini`, `.in` | `ini`, `properties` |
| ProtoBuf | `.proto` | `protobuf` |
| Pug | `.pug`, `.jade` | `jade`, `pug` |
| Puppet | `.pp` | `puppet` |
| Python | `.build`, `.bzl`, `.py`, `.pyw`, `BUCK`, `BUILD` | `py`, `python` |
| Q | `.q` | `q` |
| R | `.r` | `r`, `rscript` |
| RPM Changes | None | None |
| RPM Spec | `.spec` | None |
| Ruby | `.rb`, `Gemfile`, `Rakefile` | `rb`, `ruby`, `jruby`, `macruby`, `rake`, `rbx` |
| Rust | `.rs` | `rs`, `rust` |
| SAS | `.sas` | `sas` |
| Sass | `.sass` | `sass` |
| Scala | `.scala` | `scala` |
| Scheme | `.scm`, `.ss` | `scheme` |
| SCSS | `.scss` | `scss` |
| Shell | `.sh`, `.ksh`, `.bash`, `PKGBUILD` | `sh`, `bash`, `zsh`, `shell`, `shellsession`, `console` |
| Sieve | `.siv`, `.sieve` | `sieve` |
| Smalltalk | `.st` | `smalltalk` |
| SML | `.sml`, `.fun`, `.smackspec` | `sml` |
| Solr | None | `solr` |
| SPARQL | `.rq`, `.sparql` | `sparql`, `sparul` |
| Spreadsheet | None | `excel`, `formula`, `spreadsheet` |
| SQL | `.sql` | `sql` |
| SQLite | None | `sqlite` |
| Squirrel | `.nut` | `squirrel` |
| sTeX | None | `stex` |
| Stylus | `.styl` | `stylus` |
| Swift | `.swift` | `swift` |
| SystemVerilog | `.v`, `.sv`, `.svh` | `systemverilog` |
| Tcl | `.tcl` | `tcl` |
| Textile | `.textile` | `textile` |
| TiddlyWiki | None | `tiddlywiki` |
| Tiki wiki | None | None |
| TOML | `.toml` | `toml` |
| Troff | `.1`, `.2`, `.3`, `.4`, `.5`, `.6`, `.7`, `.8`, `.9` | `troff` |
| TSX | `.tsx` | `tsx` |
| TTCN | `.ttcn`, `.ttcn3`, `.ttcnpp` | `ttcn` |
| TTCN_CFG | `.cfg` | `ttcn_cfg` |
| Turtle | `.ttl` | `turtle` |
| TypeScript | `.ts`, `.mts`, `.cts` | `ts`, `typescript` |
| VB.NET | `.vb` | `vb.net` |
| VBScript | `.vbs` | `vbscript` |
| Velocity | `.vtl` | `velocity` |
| Verilog | None | `verilog` |
| VHDL | `.vhd`, `.vhdl` | `vhdl` |
| Vue | `.vue` | `vue` |
| Web IDL | `.webidl` | None |
| WebAssembly | `.wat`, `.wast` | `webassembly` |
| XML | `.xml`, `.xsl`, `.xsd`, `.svg` | `xml`, `rss`, `wsdl`, `xsd` |
| XQuery | `.xy`, `.xquery`, `.xq`, `.xqm`, `.xqy` | `xquery` |
| Xù | `.xu` | `xù` |
| Yacas | `.ys` | `yacas` |
| YAML | `.yaml`, `.yml` | `yaml`, `yml` |
| Z80 | `.z80` | `z80` |

### Matching Notes

- Shared extensions use the first registered match: `.m` selects Mathematica, not Objective-C or Octave; `.sig` selects PGP, not SML; `.v` selects SystemVerilog, not Verilog.
- Only the final filename suffix is checked. For example, `project.cmake.in` selects Properties files through `.in`, not CMake.
- Entries without a Markdown shortcode have no accepted single-word label. Their full names won't work in fences.

## Related Guides

- [Edit Markdown](../../viewing-and-editing-files/edit-markdown/)
- [Supported File Formats](../supported-file-formats/)
