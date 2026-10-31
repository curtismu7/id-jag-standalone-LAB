# SAML subject token spike

**Question:** does PingFederate 13.1.3 accept a SAML 2.0 assertion as the `subject_token` of a token exchange that mints
an ID-JAG? **Answer (2026-10-19): yes.** The PingFederate 13.1 docs list only ID tokens and refresh tokens as ID-JAG
sources; the SAML 2.0 token processor works anyway.

```
POST /as/token.oauth2   (client auth: a confidential client allowed the token-exchange grant)
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  subject_token=<base64url of the signed SAML 2.0 assertion XML>
  subject_token_type=urn:ietf:params:oauth:token-type:saml2
  requested_token_type=urn:ietf:params:oauth:token-type:id-jag
  audience=<the SP connection's entityId>   resource=<its resource URI>   scope=…
-> 200 { issued_token_type: …id-jag, access_token: <ID-JAG, typ oauth-id-jag+jwt, sub = the assertion's NameID> }
```

What PingFederate needs (all created by `spike.mjs setup`, ids prefixed `idJagSpike`, nothing existing is touched):

- the signer's certificate imported as a **trusted CA** (id must be lower case); trust comes from the CA store, not from
  an IdP connection;
- a **SAML 2.0 token processor** (`Saml20TokenProcessor`) whose only setting is the Audience the assertion must carry;
- a **token exchange processor policy** mapping `urn:ietf:params:oauth:token-type:saml2` to that processor
  (subject from `SAML_SUBJECT`), and an **SP connection** with ID-JAG enabled that maps the policy.

Refused, each with its own error (`negatives.mjs`): a tampered subject (`INVALID signature`), the wrong audience, an
expired assertion (`Time condition`), a key PingFederate does not trust (`Certificate path validation failed`), and an
unsigned assertion (`NOT_PRESENT signature`). Plain base64 and base64url both work.

## Run it

```
cd tools/saml-spike && npm ci && npm test            # offline: the assertion generator
kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
node spike.mjs setup    --ns=<ns>
node spike.mjs exchange --pf=https://<your PingFederate>
node negatives.mjs                                    # needs the same PF_URL base as spike.mjs (edit PF at the top)
node spike.mjs remove   --ns=<ns>
```

The assertion's NotBefore is backdated 60 s so a PingFederate clock a few seconds behind does not read as "not yet
valid". Keys are throwaway and live in `work/` (mode 600, gitignored).
