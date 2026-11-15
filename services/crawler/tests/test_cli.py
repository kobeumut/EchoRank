"""geo-crawler CLI. Its ``--lang`` is the Wikidata search language; the report language (``--lang en|tr``) belongs to
geo-audit / geo-autogeo / geo-botsim, which are covered in test_scoring / test_autogeo / test_bot_simulator."""
import json

from fixtures import BASE

from geo_crawler.cli import main


def test_cli(fake_site, tmp_path, capsys):
    out = tmp_path / "g.json"
    pages = tmp_path / "pages.json"
    rc = main([BASE, "-o", str(out), "--pages-output", str(pages), "--rps", "0", "--depth", "2"])
    assert rc == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["nodes"] and data["edges"]
    assert json.loads(pages.read_text(encoding="utf-8"))[0]["url"].startswith(BASE)
    summary = json.loads(capsys.readouterr().err)
    assert summary["crawl"]["pages_crawled"] > 0


def test_cli_lang_is_the_wikidata_search_language(fake_site, tmp_path, capsys):
    out = tmp_path / "g.json"
    assert main([BASE, "-o", str(out), "--rps", "0", "--depth", "1", "--lang", "tr", "--max-concepts", "3"]) == 0
    capsys.readouterr()
    assert json.loads(out.read_text(encoding="utf-8"))["nodes"]
