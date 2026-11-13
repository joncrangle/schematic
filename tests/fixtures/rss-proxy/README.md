# RSS forwarding contract

These authored, offline documents exercise the XML document guard shared by the
Rust forwarding proxy and Core RSS decoder. They contain fictional routes and
sources. Valid documents are one RSS document with one channel or one Atom feed;
HTML, missing/duplicate channels, truncated XML, multiple roots, DTDs, undeclared
namespaces/entities, invalid character references, and blank responses fail.
Every recognized posting must have a visible non-empty title; missing or blank
titles fail the whole observation instead of proving an empty feed. Forwarding must preserve the bytes, including CDATA, category
metadata, IDs, dates, and links; Core alone maps these into alerts.
