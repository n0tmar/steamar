-- quotes and punctuation are the part a naive parser gets wrong
seteticketurl("https://example.invalid/a(b),c--d")   -- trailing comment, not part of the url
addtoken(730, '76561198000000000')
setManifestid(731, "10, 20")                         -- a comma inside a string stays inside it
seteticketurl("say \"hi\"")                          -- escaped quote
addappid(732, 1, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")
