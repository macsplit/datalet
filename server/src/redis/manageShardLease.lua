-- Refresh or release a materializer shard lease only while it is still owned
-- by this exact process instance. This avoids refreshing another process's
-- replacement lease after a long pause, and avoids deleting it during stop.

if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

local ttl = tonumber(ARGV[2])
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
else
  redis.call('DEL', KEYS[1])
end
return 1
