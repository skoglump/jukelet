"""Single-owner authentication. SQLite stores no reusable session cookies."""

import hashlib
import hmac
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable

from sqlalchemy import Engine, delete
from sqlalchemy.orm import Session

from jukelet.storage import OwnerSession

SESSION_SECONDS = 8 * 60 * 60
COOKIE_NAME = "jukelet_session"


class AuthService:
    def __init__(
        self, engine: Engine, secret: bytes, clock: Callable[[], float] = time.time
    ) -> None:
        self.engine = engine
        self.secret = secret
        self.clock = clock
        self.attempts: deque[float] = deque()
        self.lock = threading.Lock()

    def allow_attempt(self) -> bool:
        # A bounded global limiter is intentional for this single-owner, single-worker app.
        with self.lock:
            now = self.clock()
            while self.attempts and self.attempts[0] <= now - 60:
                self.attempts.popleft()
            if len(self.attempts) >= 10:
                return False
            self.attempts.append(now)
            return True

    def token_hash(self, token: str) -> str:
        # Binding storage keys to the app secret revokes existing sessions on secret rotation.
        return hmac.new(self.secret, token.encode(), hashlib.sha256).hexdigest()

    def login(self, candidate: str, previous_token: str | None) -> tuple[str, OwnerSession] | None:
        if not hmac.compare_digest(candidate.encode(), self.secret):
            return None
        token = secrets.token_urlsafe(32)
        record = OwnerSession(
            token_hash=self.token_hash(token),
            csrf_token=secrets.token_urlsafe(32),
            expires_at=int(self.clock()) + SESSION_SECONDS,
        )
        with Session(self.engine, expire_on_commit=False) as db, db.begin():
            db.execute(delete(OwnerSession).where(OwnerSession.expires_at <= int(self.clock())))
            if previous_token:
                db.execute(
                    delete(OwnerSession).where(
                        OwnerSession.token_hash == self.token_hash(previous_token)
                    )
                )
            db.add(record)
        return token, record

    def lookup(self, token: str | None) -> OwnerSession | None:
        if token is None or len(token) > 128:
            return None
        with Session(self.engine) as db:
            record = db.get(OwnerSession, self.token_hash(token))
            if record is None or record.expires_at <= self.clock():
                return None
            return record

    def revoke(self, record: OwnerSession) -> None:
        with Session(self.engine) as db, db.begin():
            db.execute(delete(OwnerSession).where(OwnerSession.token_hash == record.token_hash))
