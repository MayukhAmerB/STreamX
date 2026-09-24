import { useEffect, useState } from "react";

import { listSocialAccounts } from "../api/socialAccounts";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";
import "./AccountsDirectoryPage.css";

const PLATFORM_LABELS = {
  youtube: "YouTube",
  instagram: "Instagram",
  x: "X",
  facebook: "Facebook",
  link: "Official link",
};

export function normalizeAccountDirectory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((category) => category && category.id && category.name && category.slug)
    .map((category) => ({
      ...category,
      accounts: Array.isArray(category.accounts)
        ? category.accounts.filter((account) => account && account.id && account.account_name && account.url)
        : [],
    }));
}

function PlatformIcon({ iconKey }) {
  if (iconKey === "youtube") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3.5" y="7.5" width="25" height="17" rx="5" />
        <path d="m13.5 12 7 4-7 4Z" className="as-icon-fill" />
      </svg>
    );
  }
  if (iconKey === "instagram") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="5" y="5" width="22" height="22" rx="6" />
        <circle cx="16" cy="16" r="5.2" />
        <circle cx="23" cy="9" r="1.2" className="as-icon-fill" />
      </svg>
    );
  }
  if (iconKey === "x") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M7 6.5 24.5 25.5M24.8 6.5 7.5 25.5" />
      </svg>
    );
  }
  if (iconKey === "facebook") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M18.5 27V17h3.7l.6-4.2h-4.3v-2.7c0-1.2.4-2.1 2.2-2.1H23V4.2c-.8-.1-1.8-.2-3.2-.2-3.2 0-5.4 2-5.4 5.6v3.2H11V17h3.4v10Z" className="as-icon-fill" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M13.2 18.8 18.8 13m-8.3 9.2-1.2 1.2a4.6 4.6 0 0 1-6.5-6.5l4.1-4.1a4.6 4.6 0 0 1 6.5 0m8.1-3 1.2-1.2a4.6 4.6 0 0 1 6.5 6.5l-4.1 4.1a4.6 4.6 0 0 1-6.5 0" />
    </svg>
  );
}

function AccountRow({ account, category, index }) {
  const platformLabel = PLATFORM_LABELS[category.icon_key] || category.name;
  return (
    <a
      className="as-account-row"
      href={account.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open verified ${platformLabel} account ${account.account_name}`}
    >
      <span className="as-account-index">{String(index + 1).padStart(2, "0")}</span>
      <span className="as-platform-icon">
        <PlatformIcon iconKey={category.icon_key} />
      </span>
      <span className="as-account-identity">
        <span className="as-account-label">Account name</span>
        <strong>{account.account_name}</strong>
        {account.handle ? <span className="as-account-handle">{account.handle}</span> : null}
      </span>
      <span className="as-account-owner">
        <span>{account.managed_by ? "Managed by" : "Account type"}</span>
        <strong>{account.managed_by || platformLabel}</strong>
      </span>
      <span className="as-account-status">
        <span aria-hidden="true" />
        {account.status_label || "Active"}
      </span>
      <span className="as-account-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </span>
      {account.description ? <span className="as-account-description">{account.description}</span> : null}
    </a>
  );
}

export function AccountsDirectoryContent({ categories, loading = false, error = "", onRetry }) {
  const normalized = normalizeAccountDirectory(categories);
  const totalAccounts = normalized.reduce((total, category) => total + category.accounts.length, 0);

  return (
    <section className="as-directory-shell">
      <div className="as-directory-grid" aria-hidden="true" />
      <header className="as-directory-hero">
        <div className="as-section-number">01</div>
        <p className="as-kicker">Official account verification</p>
        <h1>Know which accounts are actually affiliated.</h1>
        <p className="as-hero-copy">
          A verified directory of public accounts associated with Al Syed Initiative. Check the account name,
          manager, and destination before following links or responding to messages.
        </p>
        <div className="as-directory-metrics" aria-label="Directory summary">
          <div><strong>{normalized.length}</strong><span>Categories</span></div>
          <div><strong>{totalAccounts}</strong><span>Verified accounts</span></div>
          <div><strong>Admin</strong><span>Controlled directory</span></div>
        </div>
      </header>

      {loading ? (
        <div className="as-directory-state" role="status">
          <span className="as-state-pulse" /> Loading the verified directory...
        </div>
      ) : error ? (
        <div className="as-directory-state as-directory-error" role="alert">
          <div>
            <strong>Directory temporarily unavailable</strong>
            <p>{error}</p>
          </div>
          {onRetry ? <button type="button" onClick={onRetry}>Try again</button> : null}
        </div>
      ) : normalized.length ? (
        <>
          <nav className="as-category-nav" aria-label="Account categories">
            {normalized.map((category) => (
              <a key={category.id} href={`#accounts-${category.slug}`}>
                <span className="as-category-nav-icon"><PlatformIcon iconKey={category.icon_key} /></span>
                <span><strong>{category.name}</strong><small>{category.accounts.length} accounts</small></span>
              </a>
            ))}
          </nav>

          <div className="as-category-stack">
            {normalized.map((category, categoryIndex) => (
              <section
                className="as-category-section"
                id={`accounts-${category.slug}`}
                key={category.id}
                aria-labelledby={`accounts-${category.slug}-title`}
              >
                <div className="as-category-heading">
                  <div className="as-section-number">{String(categoryIndex + 2).padStart(2, "0")}</div>
                  <div className="as-category-title">
                    <span className="as-category-title-icon"><PlatformIcon iconKey={category.icon_key} /></span>
                    <div>
                      <p className="as-kicker">Verified {category.name} presence</p>
                      <h2 id={`accounts-${category.slug}-title`}>{category.name} accounts</h2>
                    </div>
                  </div>
                  <p>{category.description || `Official ${category.name} accounts published by the administration.`}</p>
                </div>

                <div className="as-account-list">
                  {category.accounts.length ? (
                    category.accounts.map((account, index) => (
                      <AccountRow account={account} category={category} index={index} key={account.id} />
                    ))
                  ) : (
                    <div className="as-empty-category">
                      <span><PlatformIcon iconKey={category.icon_key} /></span>
                      <div><strong>No accounts published yet</strong><p>The administration can add verified {category.name} accounts at any time.</p></div>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="as-directory-state">
          No account categories are currently published. Please check again later.
        </div>
      )}

      <aside className="as-safety-panel">
        <div className="as-safety-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48"><path d="M24 4 39 10v11c0 10-6.4 18.3-15 23-8.6-4.7-15-13-15-23V10Z" /><path d="m17 24 4.5 4.5L31.5 18" /></svg>
        </div>
        <div>
          <p className="as-kicker">Account safety</p>
          <h2>Verify the handle. Verify the destination.</h2>
          <p>Before interacting with anyone claiming to represent us, compare their account name and URL with this directory. Unlisted profiles should be treated as unverified.</p>
        </div>
      </aside>
    </section>
  );
}

export default function AccountsDirectoryPage() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listSocialAccounts()
      .then((response) => {
        if (active) setCategories(normalizeAccountDirectory(apiData(response, [])));
      })
      .catch((requestError) => {
        if (active) {
          setCategories([]);
          setError(apiMessage(requestError, "The verified account directory could not be loaded."));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  return (
    <PageShell containerClassName="as-accounts-page">
      <AccountsDirectoryContent
        categories={categories}
        loading={loading}
        error={error}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    </PageShell>
  );
}
