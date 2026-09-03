"""
Gaussian-copula orthant probability for a stack of correlated binary legs.

The two correlations measured in joint.py cannot both come from one shared
factor: two hitters in a lineup move together at rho=0.074, while a hitter and
his own team's total move together at rho=0.361 — and 0.361 > sqrt(0.074). No
conditional-independence-given-the-team's-night model can produce that, because
the dependence is not a shared cause: a hitter's total bases *are* part of his
team's runs.

So a stack is priced with a full correlation matrix instead,

    R[team, hitter]    = RHO_TEAM_HITTER
    R[hitter, hitter'] = RHO_HITTER_HITTER

(positive-definite for every lineup size that matters), and

    P(all legs hit) = P(Y_i < Phi^-1(p_i) for all i),   Y ~ N(0, R)

evaluated with Genz's separation-of-variables transform over a deterministic
Halton sequence. No RNG, so the app and the backtest price a stack identically;
the marginals come back exactly p_i for any correlation, which is the property
that makes this safe to layer on top of models fitted one leg at a time.
"""

import numpy as np
from scipy.special import ndtr, ndtri

# Halton over the first primes. 1024 points give ~1e-4 on the integrands here
# because Genz's transform makes them smooth.
QMC_N = 1024
PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]


def halton(n, dim):
    """The first n points of the Halton sequence in `dim` dimensions."""
    out = np.empty((n, dim))
    for d in range(dim):
        b = PRIMES[d]
        for i in range(n):
            f, x, k = 1.0, 0.0, i + 1
            while k > 0:
                f /= b
                x += f * (k % b)
                k //= b
            out[i, d] = x
    return out


_HALTON = halton(QMC_N, len(PRIMES))


def corr_matrix(k_hitters, with_team, rho_hh, rho_th):
    """Correlation matrix for a stack: the team-total leg first, then hitters."""
    n = k_hitters + (1 if with_team else 0)
    R = np.eye(n)
    off = 1 if with_team else 0
    for i in range(off, n):
        for j in range(i + 1, n):
            R[i, j] = R[j, i] = rho_hh
    if with_team:
        for i in range(1, n):
            R[0, i] = R[i, 0] = rho_th
    return R


def orthant(ps, R):
    """P(all legs hit) for marginals `ps` under Gaussian copula `R` (Genz)."""
    ps = np.clip(np.asarray(ps, dtype=float), 1e-9, 1 - 1e-9)
    n = len(ps)
    if n == 1:
        return float(ps[0])
    u = ndtri(ps)
    C = np.linalg.cholesky(R)
    w = _HALTON[:, : max(n - 1, 1)]
    e = ndtr(u[0] / C[0, 0])
    f = np.full(QMC_N, e)
    y = np.zeros((QMC_N, n))
    for i in range(1, n):
        y[:, i - 1] = ndtri(np.clip(w[:, i - 1] * e, 1e-12, 1 - 1e-12))
        s = y[:, :i] @ C[i, :i]
        e = ndtr((u[i] - s) / C[i, i])
        f = f * e
    return float(f.mean())


def orthant_many(P, R):
    """`orthant` over a (m, n) matrix of marginals sharing one matrix R."""
    P = np.clip(np.asarray(P, dtype=float), 1e-9, 1 - 1e-9)
    m, n = P.shape
    if n == 1:
        return P[:, 0]
    U = ndtri(P)
    C = np.linalg.cholesky(R)
    w = _HALTON[:, : n - 1]                       # (q, n-1)
    e = ndtr(U[:, 0:1] / C[0, 0])                 # (m, 1)
    e = np.repeat(e, QMC_N, axis=1)               # (m, q)
    f = e.copy()
    Y = np.zeros((m, QMC_N, n))
    for i in range(1, n):
        Y[:, :, i - 1] = ndtri(np.clip(w[None, :, i - 1] * e, 1e-12, 1 - 1e-12))
        s = Y[:, :, :i] @ C[i, :i]                # (m, q)
        e = ndtr((U[:, i : i + 1] - s) / C[i, i])
        f = f * e
    return f.mean(axis=1)


if __name__ == "__main__":
    # Sanity: two and three legs against a dense numerical integral.
    from scipy.stats import multivariate_normal as mvn

    for ps, rho in (([0.42, 0.35], 0.3609), ([0.42, 0.35, 0.31], 0.0744)):
        n = len(ps)
        R = np.eye(n) + rho * (np.ones((n, n)) - np.eye(n))
        got = orthant(ps, R)
        want = float(mvn(mean=np.zeros(n), cov=R).cdf(ndtri(ps)))
        print(f"n={n} rho={rho}: genz {got:.6f}  scipy {want:.6f}  "
              f"diff {abs(got-want):.2e}   independence {np.prod(ps):.6f}")

    R = corr_matrix(2, True, 0.0744, 0.3609)
    ps = [0.44, 0.42, 0.35]
    got = orthant(ps, R)
    want = float(mvn(mean=np.zeros(3), cov=R).cdf(ndtri(ps)))
    print(f"team + 2 bats: genz {got:.6f}  scipy {want:.6f}  "
          f"independence {np.prod(ps):.6f}")
    print("vectorised:", orthant_many(np.array([ps, ps]), R))
