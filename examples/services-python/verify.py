import socket
import struct

with socket.create_connection(('cache', 6379)) as cache:
    cache.sendall(b'PING\r\n')
    assert b'PONG' in cache.recv(1024)
with socket.create_connection(('database', 5432)) as database:
    database.sendall(struct.pack('!II', 8, 80877103))
    assert database.recv(1) in (b'S', b'N')
print('services-ready')
