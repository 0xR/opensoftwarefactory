# Incident: empty status box for rejected claims

From: the on-call engineer

Last night, the claim status panel showed an empty status box for rejected claims.
Customers with a rejected claim see nothing and call the service desk.

Fix: the panel must tell a customer with a rejected claim what happened to the claim.

Try it: `./panel.sh 2042` prints an empty line. Claim 2042 is a rejected claim.
