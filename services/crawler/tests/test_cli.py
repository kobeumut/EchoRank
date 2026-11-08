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
