+++
title = "Text File Support and Syntax Highlighting"
+++

Use this reference to check which files open in the text viewer and which language labels you can use in Markdown code blocks. Sambee uses the same syntax highlighting for text viewing and editing, Markdown source, and code blocks in Markdown previews.

## Text File Support

Files with an extension or special filename listed below open in the text viewer by default, with two exceptions: `.md` and `.markdown` open in the Markdown viewer, and `.svg` opens in the image viewer. A saved viewer preference or the file's MIME type can override the filename-based choice.

The filename also selects the highlighting language:

- Special filenames take priority over extensions. Their case rules vary: `Dockerfile` requires that spelling, while `nginx.conf` matches in any case.
- Extensions aren't case-sensitive. Only the final suffix counts, so `project.cmake.in` uses Properties highlighting through `.in`, not CMake.
- Shared extensions select one language: `.m` uses Mathematica, `.sig` uses PGP, and `.v` uses SystemVerilog.

Plain-text formats such as `.txt` and `.log` open in the text viewer without highlighting. Unmatched files don't automatically open as text, but you can choose the text viewer from the viewer picker; without a language match, they use plain text.

For images, PDFs, archives, and other supported formats, see [Supported File Formats](../supported-file-formats/).

## Markdown Code Block Languages

Put a language label immediately after the opening three backticks. For example, `py` selects Python:

````markdown
```py
def greet(name):
	return f"Hello, {name}!"
```
````

Labels aren't case-sensitive. Labels on the same table row are interchangeable, so `python` works just like `py`. Sambee reads only the first whitespace-separated word after the opening fence; a language's full name works only if it's listed as a label.

Unlabelled blocks and unknown labels use plain text. To request plain text explicitly, use `text`, `txt`, `plaintext`, `plain`, or `none`. Very large code blocks can also remain plain text without losing their contents.

## File and Language Reference

Use the file column to look up a file and the Markdown column to choose a code block label. **None** in the file or viewer column means the language is available only in Markdown code blocks. **None** in the Markdown column means there's no accepted code block label for that format. Viewer choices assume no MIME-type or saved-preference override.

| Language or format | File extensions or names | Markdown labels | Default viewer |
|---|---|---|---|
| APL | `.dyalog`, `.apl` | `apl` | Text |
| ASN.1 | `.asn`, `.asn1` | `asn.1` | Text |
| Asterisk | `extensions.conf` | `asterisk` | Text |
| Brainfuck | `.b`, `.bf` | `brainfuck` | Text |
| C | `.c`, `.h`, `.ino` | `c` | Text |
| C# | `.cs` | `cs`, `csharp`, `c#` | Text |
| C++ | `.cpp`, `.c++`, `.cc`, `.cxx`, `.hpp`, `.h++`, `.hh`, `.hxx` | `cpp`, `c++` | Text |
| Clojure | `.clj`, `.cljc`, `.cljx` | `clojure` | Text |
| ClojureScript | `.cljs` | `clojurescript` | Text |
| Closure Stylesheets (GSS) | `.gss` | None | Text |
| CMake | `.cmake`, `CMakeLists.txt` | `cmake` | Text |
| COBOL | `.cob`, `.cpy` | `cobol` | Text |
| CoffeeScript | `.coffee` | `coffee`, `coffee-script`, `coffeescript` | Text |
| Common Lisp | `.cl`, `.lisp`, `.el` | `lisp` | Text |
| CQL (Cassandra) | `.cql` | `cql`, `cassandra` | Text |
| Crystal | `.cr` | `crystal` | Text |
| CSS | `.css` | `css` | Text |
| Cypher | `.cyp`, `.cypher` | `cypher` | Text |
| Cython | `.pyx`, `.pxd`, `.pxi` | `cython` | Text |
| D | `.d` | `d` | Text |
| Dart | `.dart` | `dart` | Text |
| Diff | `.diff`, `.patch` | `diff` | Text |
| Dockerfile | `Dockerfile` | `docker`, `dockerfile` | Text |
| DTD | `.dtd` | `dtd` | Text |
| Dylan | `.dylan`, `.dyl`, `.intr` | `dylan` | Text |
| EBNF | None | `ebnf` | None |
| ECL | `.ecl` | `ecl` | Text |
| edn | `.edn` | `edn` | Text |
| Eiffel | `.e` | `eiffel` | Text |
| Elm | `.elm` | `elm` | Text |
| Erlang | `.erl` | `erlang` | Text |
| Esper | None | `esper` | None |
| F# | `.fs` | `fsharp`, `f#` | Text |
| Factor | `.factor` | `factor` | Text |
| FCL | None | `fcl` | None |
| Forth | `.forth`, `.fth`, `.4th` | `forth` | Text |
| Fortran | `.f`, `.for`, `.f77`, `.f90`, `.f95` | `fortran` | Text |
| Gas (GNU assembler) | `.s` | `gas` | Text |
| Gherkin | `.feature` | `gherkin` | Text |
| Go | `.go` | `go` | Text |
| Groovy | `.groovy`, `.gradle`, `Jenkinsfile` | `groovy` | Text |
| Haskell | `.hs` | `haskell` | Text |
| Haxe | `.hx` | `haxe` | Text |
| HTML | `.html`, `.htm`, `.handlebars`, `.hbs` | `html`, `htm`, `xhtml` | Text |
| HTTP | None | `http` | None |
| HXML | `.hxml` | `hxml` | Text |
| IDL | `.pro` | `idl` | Text |
| Java | `.java` | `java` | Text |
| JavaScript | `.js`, `.mjs`, `.cjs` | `js`, `javascript`, `ecmascript`, `node` | Text |
| Jinja | `.j2`, `.jinja`, `.jinja2` | `jinja` | Text |
| JSON | `.json`, `.map` | `json`, `json5` | Text |
| JSON-LD | `.jsonld` | `jsonld`, `json-ld` | Text |
| JSX | `.jsx` | `jsx` | Text |
| Julia | `.jl` | `julia` | Text |
| Kotlin | `.kt`, `.kts` | `kt`, `kotlin` | Text |
| LaTeX | `.text`, `.ltx`, `.tex` | `tex`, `latex` | Text |
| LESS | `.less` | `less` | Text |
| Liquid | `.liquid` | `liquid` | Text |
| LiveScript | `.ls` | `ls`, `livescript` | Text |
| Lua | `.lua` | `lua` | Text |
| MariaDB SQL | None | `mariadb` | None |
| Markdown | `.md`, `.markdown` | `md`, `markdown` | Markdown |
| Markdown source | `.mkd` | `md`, `markdown` | Text |
| Mathematica | `.m`, `.nb`, `.wl`, `.wls` | `mathematica` | Text |
| Mbox | `.mbox` | `mbox` | Text |
| mIRC | `.mrc` | `mirc` | Text |
| Modelica | `.mo` | `modelica` | Text |
| MS SQL | None | `mssql` | None |
| MscGen | `.mscgen`, `.mscin`, `.msc` | `mscgen` | Text |
| MsGenny | `.msgenny` | `msgenny` | Text |
| MUMPS | `.mps` | `mumps` | Text |
| MySQL | None | `mysql` | None |
| Nginx | Names ending in `.conf` that contain `nginx`, such as `nginx.conf` | `nginx` | Text |
| NSIS | `.nsh`, `.nsi` | `nsis` | Text |
| NTriples | `.nt`, `.nq` | `ntriples` | Text |
| Objective-C | None | `objective-c`, `objc` | None |
| Objective-C++ | `.mm` | `objective-c++`, `objc++` | Text |
| OCaml | `.ml`, `.mli`, `.mll`, `.mly` | `ocaml` | Text |
| Octave | None | `octave` | None |
| Oz | `.oz` | `oz` | Text |
| Pascal | `.p`, `.pas` | `pascal` | Text |
| Perl | `.pl`, `.pm` | `perl` | Text |
| PGP | `.asc`, `.pgp`, `.sig` | `pgp`, `asciiarmor` | Text |
| PHP | `.php`, `.php3`, `.php4`, `.php5`, `.php7`, `.phtml` | `php` | Text |
| Pig | `.pig` | `pig` | Text |
| Plain text (no highlighting) | `.txt`, `.conf`, `.log`, `.env`, `.bat`, `.cmd` | `text`, `txt`, `plaintext`, `plain`, `none` | Text |
| PLSQL | `.pls` | `plsql` | Text |
| PostgreSQL | None | `postgresql` | None |
| PowerShell | `.ps1`, `.psd1`, `.psm1` | `ps1`, `powershell` | Text |
| Properties files | `.properties`, `.ini`, `.in` | `ini`, `properties` | Text |
| ProtoBuf | `.proto` | `protobuf` | Text |
| Pug | `.pug`, `.jade` | `jade`, `pug` | Text |
| Puppet | `.pp` | `puppet` | Text |
| Python | `.build`, `.bzl`, `.py`, `.pyw`, `BUCK`, `BUILD` | `py`, `python` | Text |
| Q | `.q` | `q` | Text |
| R | `.r` | `r`, `rscript` | Text |
| RPM Spec | `.spec` | None | Text |
| Ruby | `.rb`, `Gemfile`, `Rakefile` | `rb`, `ruby`, `jruby`, `macruby`, `rake`, `rbx` | Text |
| Rust | `.rs` | `rs`, `rust` | Text |
| SAS | `.sas` | `sas` | Text |
| Sass | `.sass` | `sass` | Text |
| Scala | `.scala` | `scala` | Text |
| Scheme | `.scm`, `.ss` | `scheme` | Text |
| SCSS | `.scss` | `scss` | Text |
| Shell | `.sh`, `.ksh`, `.bash`, `PKGBUILD` | `sh`, `bash`, `zsh`, `shell`, `shellsession`, `console` | Text |
| Sieve | `.siv`, `.sieve` | `sieve` | Text |
| Smalltalk | `.st` | `smalltalk` | Text |
| SML | `.sml`, `.fun`, `.smackspec` | `sml` | Text |
| Solr | None | `solr` | None |
| SPARQL | `.rq`, `.sparql` | `sparql`, `sparul` | Text |
| Spreadsheet | None | `excel`, `formula`, `spreadsheet` | None |
| SQL | `.sql` | `sql` | Text |
| SQLite | None | `sqlite` | None |
| Squirrel | `.nut` | `squirrel` | Text |
| sTeX | None | `stex` | None |
| Stylus | `.styl` | `stylus` | Text |
| SVG (XML highlighting) | `.svg` | `xml`, `rss`, `wsdl`, `xsd` | Image |
| Swift | `.swift` | `swift` | Text |
| SystemVerilog | `.v`, `.sv`, `.svh` | `systemverilog` | Text |
| Tcl | `.tcl` | `tcl` | Text |
| Textile | `.textile` | `textile` | Text |
| TiddlyWiki | None | `tiddlywiki` | None |
| TOML | `.toml` | `toml` | Text |
| Troff | `.1`, `.2`, `.3`, `.4`, `.5`, `.6`, `.7`, `.8`, `.9` | `troff` | Text |
| TSX | `.tsx` | `tsx` | Text |
| TTCN | `.ttcn`, `.ttcn3`, `.ttcnpp` | `ttcn` | Text |
| TTCN_CFG | `.cfg` | `ttcn_cfg` | Text |
| Turtle | `.ttl` | `turtle` | Text |
| TypeScript | `.ts`, `.mts`, `.cts` | `ts`, `typescript` | Text |
| VB.NET | `.vb` | `vb.net` | Text |
| VBScript | `.vbs` | `vbscript` | Text |
| Velocity | `.vtl` | `velocity` | Text |
| Verilog | None | `verilog` | None |
| VHDL | `.vhd`, `.vhdl` | `vhdl` | Text |
| Vue | `.vue` | `vue` | Text |
| Web IDL | `.webidl` | None | Text |
| WebAssembly | `.wat`, `.wast` | `webassembly` | Text |
| XML | `.xml`, `.xsl`, `.xsd` | `xml`, `rss`, `wsdl`, `xsd` | Text |
| XQuery | `.xy`, `.xquery`, `.xq`, `.xqm`, `.xqy` | `xquery` | Text |
| Xù | `.xu` | `xù` | Text |
| Yacas | `.ys` | `yacas` | Text |
| YAML | `.yaml`, `.yml` | `yaml`, `yml` | Text |
| Z80 | `.z80` | `z80` | Text |

## Related Guides

- [Edit Markdown](../../viewing-and-editing-files/edit-markdown/)
- [Supported File Formats](../supported-file-formats/)
