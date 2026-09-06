# priv

Platz für eigene Notizen, Zwischenstände und alles, was nur dich angeht.

Der Inhalt wird ganz normal mitversioniert. Ob er das soll, entscheidet das
Projekt: Der Block „Lokale Einstellungen" in der Oberfläche zeigt den gemessenen
Ist-Zustand dieses Verzeichnisses und schaltet ihn um — er legt die .gitignore
an und nimmt bereits versionierte Dateien aus dem Index.

Von Hand geht es genauso: eine .gitignore in diesem Verzeichnis mit diesem
Inhalt:

    *
    !.gitignore
    !README.md

Dann bleibt der Inhalt draußen und das Verzeichnis selbst sichtbar. Was bereits
committet ist, nimmt erst ein `git rm --cached` wieder heraus — eine .gitignore
allein wirkt auf getrackte Dateien nicht. Und was schon gepusht wurde, bleibt in
der Historie; das macht kein Schalter rückgängig.

Dieses Verzeichnis gehört dem Projekt und wird von einem Update nie angefasst.
