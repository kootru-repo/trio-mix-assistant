import ipaddress
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trio_mix.tls import ensure_cert


def _load_cert(path):
    from cryptography import x509

    with open(path, "rb") as f:
        return x509.load_pem_x509_certificate(f.read())


def _lifetime_days(c):
    nb = getattr(c, "not_valid_before_utc", None) or c.not_valid_before
    na = getattr(c, "not_valid_after_utc", None) or c.not_valid_after
    return (na - nb).days


def _write_overlong(certfile, keyfile, days=3650):
    """Write a self-signed cert with an over-long validity (the old 10-year bug)."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "old")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    with open(keyfile, "wb") as f:
        f.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            )
        )
    with open(certfile, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


class TestTLS(unittest.TestCase):
    def test_cert_is_browser_acceptable(self):
        d = tempfile.mkdtemp(prefix="autofoh_cert_")
        try:
            cert, _ = ensure_cert(d, ["127.0.0.1"])
            from cryptography import x509
            from cryptography.x509.oid import ExtendedKeyUsageOID

            c = _load_cert(cert)
            self.assertLessEqual(_lifetime_days(c), 398)
            eku = c.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
            self.assertIn(ExtendedKeyUsageOID.SERVER_AUTH, eku)
            bc = c.extensions.get_extension_for_class(x509.BasicConstraints).value
            self.assertFalse(bc.ca)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_overlong_cached_cert_is_regenerated(self):
        d = tempfile.mkdtemp(prefix="autofoh_cert_")
        try:
            cert, key = ensure_cert(d, ["127.0.0.1"])
            _write_overlong(cert, key)

            c0 = _load_cert(cert)
            self.assertGreater(_lifetime_days(c0), 398)
            ensure_cert(d, ["127.0.0.1"])
            c1 = _load_cert(cert)
            self.assertLessEqual(_lifetime_days(c1), 398)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_trusted_ca_mode_shapes(self):
        from cryptography import x509
        from cryptography.x509.oid import ExtendedKeyUsageOID

        from trio_mix.tls import ensure_trusted_cert

        d = tempfile.mkdtemp(prefix="autofoh_ca_")
        try:
            cert, key, ca = ensure_trusted_cert(d, ["127.0.0.1", "192.168.1.50"])
            self.assertTrue(all(os.path.exists(p) for p in (cert, key, ca)))
            ca_c = _load_cert(ca)
            self.assertTrue(ca_c.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
            leaf = _load_cert(cert)
            self.assertEqual(leaf.issuer, ca_c.subject)
            self.assertFalse(
                leaf.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
            )
            self.assertIn(
                ExtendedKeyUsageOID.SERVER_AUTH,
                leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value,
            )
            self.assertLessEqual(_lifetime_days(leaf), 398)
            san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            self.assertIn(
                ipaddress.ip_address("192.168.1.50"), san.get_values_for_type(x509.IPAddress)
            )
            _, _, ca2 = ensure_trusted_cert(d, ["127.0.0.1"])
            self.assertEqual(
                ca_c.serial_number,
                _load_cert(ca2).serial_number,
            )
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_ca_signed_cert_verifies_like_an_installed_root(self):
        import socket
        import ssl
        import threading

        from trio_mix.tls import ensure_trusted_cert

        d = tempfile.mkdtemp(prefix="autofoh_ca_")
        try:
            cert, key, ca = ensure_trusted_cert(d, ["127.0.0.1"])
            sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            sctx.load_cert_chain(cert, key)
            srv = socket.socket()
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)
            port = srv.getsockname()[1]
            errs = []

            got = []

            def _acc():
                try:
                    conn, _ = srv.accept()
                    with sctx.wrap_socket(conn, server_side=True) as ss:
                        got.append(ss.recv(2))
                        ss.sendall(b"ack")
                except (OSError, ssl.SSLError) as e:
                    errs.append(e)

            acceptor = threading.Thread(target=_acc, daemon=True)
            acceptor.start()
            cctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            cctx.load_verify_locations(ca)
            cctx.check_hostname = True
            with (
                socket.create_connection(("127.0.0.1", port), timeout=5) as s,
                cctx.wrap_socket(s, server_hostname="127.0.0.1") as ts,
            ):
                ts.sendall(b"ok")
                self.assertEqual(ts.recv(3), b"ack")
                acceptor.join(timeout=5)
            srv.close()
            self.assertFalse(acceptor.is_alive())
            self.assertEqual(errs, [])
            self.assertEqual(got, [b"ok"])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_generate_with_lan_ip_in_san(self):
        d = tempfile.mkdtemp(prefix="autofoh_cert_")
        try:
            cert, key = ensure_cert(d, ["localhost", "127.0.0.1", "192.168.1.50"])
            self.assertTrue(os.path.exists(cert) and os.path.exists(key))

            cert2, _ = ensure_cert(d, ["localhost"])
            self.assertEqual(cert, cert2)

            from cryptography import x509

            with open(cert, "rb") as f:
                c = x509.load_pem_x509_certificate(f.read())
            san = c.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            ips = san.get_values_for_type(x509.IPAddress)
            self.assertIn(ipaddress.ip_address("192.168.1.50"), ips)
            self.assertIn(ipaddress.ip_address("127.0.0.1"), ips)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
