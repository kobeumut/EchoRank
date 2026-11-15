"""English messages — namespace "signals" (llms.txt validation issues; tr/signals.py must define the same keys)."""
MESSAGES: dict[str, str] = {
    "signals.llms.empty": "the file is empty",
    "signals.llms.html_response": "returns HTML (probably a 404 page or an SPA fallback)",
    "signals.llms.no_h1": "the first line is not a '# Site Name' heading",
    "signals.llms.no_summary": "there is no short site summary starting with '>'",
    "signals.llms.no_sections": "there are no '## Section' headings",
    "signals.llms.no_links": "there are no links in the '- [Title](url): description' format",
    "signals.llms.unreachable": "could not be fetched: {error}",
    "signals.llms.wrong_content_type": "returns text/html instead of text/plain",
}
