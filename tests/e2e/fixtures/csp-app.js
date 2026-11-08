// Inline scripts are blocked on this page, so the violation recorder lives here.
window.cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, sample: e.sample });
});
