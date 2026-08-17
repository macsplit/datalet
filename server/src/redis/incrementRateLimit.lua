-- Atomically increment a fixed-window rate counter and attach its expiry on
-- the first request. Keeping these together prevents a process failure between
-- INCR and EXPIRE from leaving a permanent refusal key.

local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return count
