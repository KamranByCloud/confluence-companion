# results

Alles, was Reviews erzeugen: Ergebnisse je Familie und Datum, dazu log.md.

Der Inhalt bleibt aus der Versionskontrolle. Ein Review ist aus dem Code wiederholbar —
sein Ergebnis ist ein Stand von diesem Rechner und kein Projektwissen; log.md sagt
außerdem, wer wann was gescannt hat. Was vom Ergebnis Projektwissen ist, wandert ohnehin
heraus: in known-decisions.md und in die Tasks einer Remediation.

k-playbook legt dafür beim erstmaligen Anlegen dieses Verzeichnisses eine .gitignore mit
diesem Inhalt an:

    *
    !.gitignore
    !README.md

Der Block „Lokale Einstellungen" in der Oberfläche zeigt den gemessenen Ist-Zustand und
schaltet ihn um — auch wieder zurück; einmal umgeschaltet, bleibt es dabei. Was bereits
committet ist, nimmt erst ein `git rm --cached` wieder heraus — eine .gitignore allein
wirkt auf getrackte Dateien nicht. Und was schon gepusht wurde, bleibt in der Historie.

Dieses Verzeichnis gehört dem Projekt und wird von einem Update nie angefasst.
