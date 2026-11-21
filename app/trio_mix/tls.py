"""Self-signed certificate generation for the optional --https mode.

iOS/Android only enable Screen Wake Lock and a real PWA install over a secure
context (https). For a closed FOH LAN, a self-signed cert is enough — the
performer accepts it once on the tablet. The cert carries the laptop's LAN IP in
its SubjectAltName so Safari/Chrome accept it for that address.
"""

from __future__ import annotations

import contextlib
import ipaddress
import logging
import os

_log = logging.getLogger(__name__)


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


CERT_DAYS = 396


def ensure_cert(certdir: str, hosts: list[str]) -> tuple[str, str]:
    """Return (certfile, keyfile), generating a self-signed pair if missing or if
    the cached one is stale/over-long (see _cert_is_current)."""
    os.makedirs(certdir, exist_ok=True)
    certfile = os.path.join(certdir, "cert.pem")
    keyfile = os.path.join(certdir, "key.pem")
    if os.path.exists(certfile) and os.path.exists(keyfile) and _cert_is_current(certfile):
        return certfile, keyfile
    try:
        _generate_cryptography(certfile, keyfile, hosts)
    except ImportError:
        _generate_openssl(certfile, keyfile, hosts)
    with contextlib.suppress(OSError):
        os.chmod(keyfile, 0o600)
    return certfile, keyfile


def _cert_is_current(certfile: str) -> bool:
    """True only if the cached cert is still browser-acceptable. Regenerate when
    it is valid for > ~398 days (would trip ERR_CERT_VALIDITY_TOO_LONG / iOS hard
    fail), is expired / within 30 days of expiry, or isn't a serverAuth leaf —
    this auto-heals the old 10-year certs that couldn't be bypassed. If
    cryptography isn't importable to inspect it, keep the existing file."""
    try:
        import datetime

        from cryptography import x509
        from cryptography.x509.oid import ExtendedKeyUsageOID

        with open(certfile, "rb") as f:
            c = x509.load_pem_x509_certificate(f.read())
        nb = getattr(c, "not_valid_before_utc", None) or c.not_valid_before.replace(
            tzinfo=datetime.timezone.utc
        )
        na = getattr(c, "not_valid_after_utc", None) or c.not_valid_after.replace(
            tzinfo=datetime.timezone.utc
        )
        now = datetime.datetime.now(datetime.timezone.utc)
        if (na - nb).days > 398:
            return False
        if na - now < datetime.timedelta(days=30):
            return False
        eku = c.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        return ExtendedKeyUsageOID.SERVER_AUTH in eku
    except ImportError:
        return True
    except Exception:
        _log.debug("existing certificate unusable; it will be reissued", exc_info=True)
        return False


def _generate_cryptography(certfile: str, keyfile: str, hosts: list[str]) -> None:
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AutoFOH Mix-Assistant")])
    san = [x509.IPAddress(ipaddress.ip_address(h)) if _is_ip(h) else x509.DNSName(h) for h in hosts]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=CERT_DAYS))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
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


def _generate_openssl(certfile: str, keyfile: str, hosts: list[str]) -> None:
    import subprocess

    san = ",".join((f"IP:{h}" if _is_ip(h) else f"DNS:{h}") for h in hosts)
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            keyfile,
            "-out",
            certfile,
            "-days",
            str(CERT_DAYS),
            "-subj",
            "/CN=AutoFOH Mix-Assistant",
            "-addext",
            f"subjectAltName={san}",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-addext",
            "keyUsage=critical,digitalSignature,keyEncipherment",
            "-addext",
            "extendedKeyUsage=serverAuth",
        ],
        check=True,
        capture_output=True,
    )


CA_DAYS = 3650


class TLSUnavailable(RuntimeError):
    """Trusted-CA mode needs the `cryptography` package (no openssl fallback)."""


def ensure_trusted_cert(certdir: str, hosts: list[str]) -> tuple[str, str, str]:
    """Local-CA mode: reuse/generate a root CA, then issue a server leaf signed by
    it (short-lived, serverAuth, SAN=hosts). Install the returned ca.pem on each
    device ONCE and every connection is trusted — no warning. Returns
    (certfile, keyfile, cafile)."""
    os.makedirs(certdir, exist_ok=True)
    cafile = os.path.join(certdir, "ca.pem")
    cakey = os.path.join(certdir, "ca-key.pem")
    certfile = os.path.join(certdir, "cert.pem")
    keyfile = os.path.join(certdir, "key.pem")
    try:
        _ensure_ca(cafile, cakey)
        if not (
            os.path.exists(certfile)
            and os.path.exists(keyfile)
            and _cert_is_current(certfile)
            and _issued_by(certfile, cafile)
        ):
            _generate_leaf_from_ca(certfile, keyfile, hosts, cafile, cakey)
    except ImportError as e:
        raise TLSUnavailable("trusted-CA mode requires the 'cryptography' package") from e
    for f in (keyfile, cakey):
        with contextlib.suppress(OSError):
            os.chmod(f, 0o600)
    return certfile, keyfile, cafile


def _issued_by(certfile: str, cafile: str) -> bool:
    try:
        from cryptography import x509

        with open(certfile, "rb") as f:
            leaf = x509.load_pem_x509_certificate(f.read())
        with open(cafile, "rb") as f:
            ca = x509.load_pem_x509_certificate(f.read())
        return leaf.issuer == ca.subject
    except Exception:
        _log.debug("could not match the certificate to the local root", exc_info=True)
        return False


def _ensure_ca(cafile: str, cakey: str) -> None:
    if os.path.exists(cafile) and os.path.exists(cakey) and _cert_is_ca(cafile):
        return
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AutoFOH Mix-Assistant Local CA")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                key_cert_sign=True,
                crl_sign=True,
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    with open(cakey, "wb") as f:
        f.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            )
        )
    with open(cafile, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def _cert_is_ca(cafile: str) -> bool:
    try:
        import datetime

        from cryptography import x509

        with open(cafile, "rb") as f:
            c = x509.load_pem_x509_certificate(f.read())
        na = getattr(c, "not_valid_after_utc", None) or c.not_valid_after.replace(
            tzinfo=datetime.timezone.utc
        )
        if na - datetime.datetime.now(datetime.timezone.utc) < datetime.timedelta(days=30):
            return False
        bc = c.extensions.get_extension_for_class(x509.BasicConstraints).value
        return bool(bc.ca)
    except Exception:
        _log.debug("existing root CA unusable; it will be recreated", exc_info=True)
        return False


def _generate_leaf_from_ca(
    certfile: str, keyfile: str, hosts: list[str], cafile: str, cakey: str
) -> None:
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    with open(cafile, "rb") as f:
        ca_cert = x509.load_pem_x509_certificate(f.read())
    with open(cakey, "rb") as f:
        ca_key = serialization.load_pem_private_key(f.read(), password=None)
    if not isinstance(ca_key, rsa.RSAPrivateKey):
        raise TLSUnavailable("the local root CA key is not an RSA key; delete .certs to rebuild")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    san = [x509.IPAddress(ipaddress.ip_address(h)) if _is_ip(h) else x509.DNSName(h) for h in hosts]
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_ski = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AutoFOH Mix-Assistant")]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=CERT_DAYS))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_ski), critical=False
        )
        .sign(ca_key, hashes.SHA256())
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
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
