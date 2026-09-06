# material

Rohmaterial als Quelle für Docs: Chat-Mitschnitte, Notizen, Zulieferungen.
Es wird nie indiziert und von keinem Command geschrieben — gelesen wird es von
/k-docs-extract, geschrieben nach docs/extracted/.

Der Inhalt wird ganz normal mitversioniert. Rohmaterial enthält typischerweise
Tokens, Pfade und Namen; soll es nicht ins Repository, schaltet der Block
„Lokale Einstellungen" in der Oberfläche dieses Verzeichnis um — er legt die
.gitignore an und nimmt bereits versionierte Dateien aus dem Index.

Von Hand geht es genauso: eine .gitignore in diesem Verzeichnis mit diesem
Inhalt:

    *
    !.gitignore
    !README.md

Was bereits committet ist, nimmt erst ein `git rm --cached` wieder heraus. Und
was schon gepusht wurde, bleibt in der Historie.

Dieses Verzeichnis gehört dem Projekt und wird von einem Update nie angefasst.
