---
"@substrat-run/adapter-email": patch
---

Fix invite emails never sending: the Cloudflare transport serialized a nameless recipient as `{ email }`, an object whose `name` field is absent. The workerd `EmailAddress` runtime rejects that ("Incorrect type for the 'name' field on 'EmailAddress': … not of type 'string'"), so every send threw. Nameless addresses are now passed as bare strings (the documented shape); named addresses stay `{ email, name }`. The regression slipped through because the mock transport and the fake binding in the unit tests don't validate address shape like the real service.
