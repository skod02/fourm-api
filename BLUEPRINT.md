# Platform Blueprint

## fakeag.com

Hacking & Cracking Hub — Deep Analysis & Complete Blueprint · April 2026

Platform Overview

Type

Security Community Hub

*   Forum-style thread board for security research
*   Marketplace for tools & scripts
*   External developer licensing API
*   VIP membership tier system

Frontend

Single-Page Application

*   Hash-based client-side routing (#home, #thread/:uuid)
*   UUID-based thread addressing (e97fa889-…)
*   Sections: home, profile, listings, settings, marketplace
*   Real-time online count & activity feed

Policy

ToS & Legal

*   Educational & authorized research use only
*   No targeting of individuals or orgs without authorization
*   Responsible disclosure required for vulnerabilities
*   DMCA takedown process for hosted content

Architecture Map

FRONTEND — SINGLE-PAGE APPLICATION #home · #thread/:uuid · #profile · #listings · #marketplace · #settings · #admin COMMUNITY Thread posts & replies Announcements Reputation scoring DMCA requests VIP-gated content Reports & moderation Message inbox Login history UUID-based thread addressing #thread/e97fa889-809f-4746-… MARKETPLACE Tool & script listings Listing categories Pending / active status VIP requirement bypass Seller verification DMCA compliance Escrow & reviews Skip requirements (VIP) VIP members skip download gates All upgraded members always have access DEVELOPER API License key validation (POST /api/ext/validate) HWID device binding & enforcement Key usage logs (who, when, from IP) Webhook push notifications (admin) Announcement broadcast to users App stats: total users, keys, online Auth keys summary & recent activity X-API-Secret header authentication External tools embed this API for licensing HWID = sha256(uuid.getnode()) truncated to 32 chars USER & AUTH SYSTEM login sessions · login history · API secret key · VIP key management · username history · inbox ban enforcement · reputation score · reports · moderation queue · password reset requests guest user VIP moderator admin Ban system · DMCA mgmt · Content moderation VIP key approval · User role assignment Push notifications · Pending listings

Module Deep Dive

Community Module

Thread Board

*   UUID-addressed threads (e97fa889-… format)
*   Hash-routed: #thread/:uuid in SPA
*   Quality post requirements — low-effort posts removed
*   Reputation system tracks user standing
*   VIP-gated threads require membership to view
*   Announcement system for platform-wide notices
*   No targeting of individuals or orgs
*   Responsible disclosure for vuln posts

Marketplace

Tool & Script Hub

*   Listings for tools, scripts, services
*   Pending → active listing lifecycle
*   VIP members skip access requirements on free tools
*   "No listings yet" state for new sellers
*   No spam or advertising in posts
*   DMCA compliance process for content takedowns
*   Seller verification to reduce fraud
*   Category-based browsing

Developer API

Licensing Engine

*   External tools embed the API for key-based auth
*   HWID binding: sha256(uuid.getnode())\[:32\]
*   Key statuses: valid, expired, banned, maxed
*   X-API-Secret header for API authentication
*   Regenerating API secret invalidates previous
*   Webhook: admin receives all push notifications
*   Announcements API: fetch active notices for display in tool
*   App stats: total users, threads, keys, online count

User System

Identity & Auth

*   Username: 1 free change; unlimited with VIP
*   Login history tracked per account
*   Password reset request log
*   No login history recorded for guests
*   Report system for content violations
*   Ban system with right-to-ban for policy violations
*   API secret key — regeneration invalidates old
*   VIP key status with real-time refresh

Admin Panel

Control & Moderation

*   User list: role, VIP, ban status, reputation
*   Recent activity feed: threads, listings
*   VIP request queue — approve or deny
*   Pending listings review before publish
*   DMCA takedown management
*   No reports shown to regular users
*   Push notification control via webhooks
*   Announcement creation & management

Inbox & Messaging

Private Communication

*   "No messages yet. Say hello!" — empty state
*   Direct message system between users
*   Notification system tied to user account
*   VIP request submission via internal form
*   Password reset requests tracked
*   No login history for fresh accounts
*   Reports visible only to moderation team

Developer API — Endpoint Reference

external tool (client app) key validation request POST /api/ext/validate · {key, device\_id} auth & key lookup X-API-Secret header · key status check webhook admin push notification device binding check HWID vs registered device\_id match → {status:'ok'} tool proceeds normally error → {status:'…'} invalid · expired · banned · maxed

| Method | Endpoint | Description | Auth |
| --- | --- | --- | --- |
| POST | `/api/ext/validate` | Validate a license key + HWID device binding | `X-API-Secret` |
| GET | `/api/ext/announcements` | Fetch all active platform announcements | `X-API-Secret` |
| POST | `/api/ext/announcements` | Create a new announcement | `X-API-Secret` |
| GET | `/api/ext/stats` | App stats: total users, threads, keys, online | `X-API-Secret` |
| GET | `/api/ext/keys/summary` | Auth key counts by status, recent key usage | `X-API-Secret` |
| GET | `/api/ext/users` | User list with role, VIP status, ban status, reputation | `X-API-Secret` |
| GET | `/api/ext/activity` | Recent activity feed: threads, listings | `X-API-Secret` |

Membership Tiers

GUEST

Browse

No account required

Browse public threads

View marketplace listings

Post or reply to threads

Access inbox

API secret access

VIP-gated content

Marketplace selling

REGISTERED USER

Participate

Free after signup

Post threads & replies

Message inbox

Reputation system

API secret key access

1 free username change

VIP key activation

Skip download gates

VIP ✦

Full Access

Upgraded / earned membership

All user features

Skip VIP requirements on downloads

Unlimited username changes

Priority content access

Marketplace selling enabled

VIP key for external tools

Always bypasses access gates

Data Model

USERS

iduuid PK

usernamestring · unique

roleenum: guest|user|mod|admin

is\_vipboolean

is\_bannedboolean

reputationinteger

api\_secretstring · hashed

vip\_keystring · nullable

username\_changesinteger

created\_attimestamp

THREADS

iduuid PK

titlestring

contenttext

author\_iduuid FK → users

sectionstring (category)

vip\_onlyboolean

is\_announcementboolean

statusenum: active|removed

created\_attimestamp

LICENSE\_KEYS

keystring (XXXX-XXXX-…) PK

app\_iduuid FK → apps

statusenum: valid|expired|banned|maxed

max\_devicesinteger

device\_idsstring\[\] (HWIDs)

usage\_countinteger

expires\_attimestamp · nullable

last\_used\_attimestamp

last\_ipinet

LISTINGS (MARKETPLACE)

iduuid PK

titlestring

descriptiontext

seller\_iduuid FK → users

categorystring

statusenum: pending|active|removed

vip\_requiredboolean

pricedecimal · nullable (free)

created\_attimestamp

Frontend Route Map

| Hash Route | Module | Access | Notes |
| --- | --- | --- | --- |
| `#home` | Community | Public | Thread feed, announcements, recent activity |
| `#thread/:uuid` | Community | Public / VIP-gated | UUID addressed, e.g. e97fa889-809f-4746-a712-c12366c49342 |
| `#listings` | Marketplace | Public | Browse tool & script listings |
| `#marketplace` | Marketplace | User+ | Selling, managing listings |
| `#profile` | User | User+ | Username, reputation, history, inbox |
| `#settings` | User | User+ | API secret, VIP key, password reset |
| `#admin` | Admin | Admin only | User mgmt, DMCA, reports, VIP queue, pending listings |

Inferred Tech Stack

Routing

Hash SPA

Auth

API Secret + Sessions

Key Format

XXXX-XXXX-XXXX-XXXX-XXXX

HWID

sha256(MAC)\[:32\]

Thread IDs

UUIDs (v4)

Webhooks

Push · Admin mode

API Auth

X-API-Secret header

External SDK

Python requests

Strategic Insights

Business Model

VIP Monetization

*   VIP membership unlocks marketplace selling, skip gates, unlimited username changes
*   Tool developers pay indirectly by using the licensing API (brand/platform lock-in)
*   Community content creates free value; VIP extracts premium from power users
*   External tool integration means fakeag.com becomes infrastructure, not just a forum

Differentiation

Embedded Licensing

*   The developer API is a major differentiator — forum + SaaS licensing in one
*   HWID binding ties licenses to physical hardware, reducing key sharing
*   Webhook system gives tool developers real-time admin control
*   Announcement API lets developers push updates to their tool users via fakeag.com

Risk Surface

Compliance & ToS

*   Educational/authorized research framing is the legal wrapper
*   DMCA process gives takedown compliance but shifts liability to users
*   No targeting of individuals/orgs without authorization is explicitly stated
*   Responsible disclosure requirement signals awareness of legal exposure
