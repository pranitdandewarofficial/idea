"""Knowledge base: ingestion, chunking and retrieval.

Uploaded content is **untrusted evidence**.  It is never inserted into a system
prompt as instructions; it is quoted inside a clearly-labelled evidence block and
the agent is told that any instructions inside it must be ignored.
"""
