import * as crypto from "crypto";
import * as url from "url";
import * as express from "express";
import * as path from "path";
import * as GoogleStrategy from "passport-google-oauth20";
import * as LocalStrategy from "passport-local";
import * as passport from "passport";
import { Config } from "./Config";
import { Crypt } from "./Crypt";
import { Audit } from "./Audit";
import * as saml from "saml20";
const multer = require('multer');
// const GridFsStorage = require('multer-gridfs-storage');
import { GridFsStorage } from "multer-gridfs-storage";
import { GridFSBucket, ObjectID, Binary } from "mongodb";
import { Base, User, NoderedUtil, TokenUser, WellknownIds, Rights, Role, InsertOrUpdateOneMessage } from "@openiap/openflow-api";
import { Span } from "@opentelemetry/api";
import { Logger } from "./Logger";
import { DatabaseConnection } from "./DatabaseConnection";
import { TokenRequest } from "./TokenRequest";
const safeObjectID = (s: string | number | ObjectID) => ObjectID.isValid(s) ? new ObjectID(s) : null;

interface IVerifyFunction { (error: any, profile: any): void; }
export class Provider extends Base {
    constructor() {
        super();
        this._type = "provider";
    }
    public provider: string = "";
    public id: string = "";
    public name: string = "";
    public issuer: string = "";
    public saml_federation_metadata: string = "";
    public consumerKey: string;
    public consumerSecret: string;
    public saml_signout_url: string;
}
// tslint:disable-next-line: class-name
export class googleauthstrategyoptions {
    public clientID: string = "";
    public clientSecret: string = "";
    public callbackURL: string = "auth/strategy/callback/";
    public scope: string[] = ["profile", "email"];
    public verify: any;
}
// tslint:disable-next-line: class-name
export class samlauthstrategyoptions {
    public callbackUrl: string = "auth/strategy/callback/";
    public entryPoint: string = "";
    public issuer: string = "";
    public cert: string = null;

    public audience: string = null;
    public signatureAlgorithm: 'sha1' | 'sha256' | 'sha512' = "sha256";
    public callbackMethod: string = "POST";
    public verify: any;
}
export class LoginProvider {
    public static _providers: any = {};
    // public static login_providers: Provider[] = [];

    public static remoteip(req: express.Request) {
        let remoteip: string = req.socket.remoteAddress;
        if (req.headers["X-Forwarded-For"] != null) remoteip = req.headers["X-Forwarded-For"] as string;
        if (req.headers["X-real-IP"] != null) remoteip = req.headers["X-real-IP"] as string;
        if (req.headers["x-forwarded-for"] != null) remoteip = req.headers["x-forwarded-for"] as string;
        if (req.headers["x-real-ip"] != null) remoteip = req.headers["x-real-ip"] as string;
        return remoteip;
    }
    public static escape(s: string): string {
        let lookup: any = {
            '&': "&amp;",
            '"': "&quot;",
            '<': "&lt;",
            '>': "&gt;"
        };
        return s.replace(/[&"<>]/g, (c) => lookup[c]);
    }
    public static redirect(res: any, originalUrl: string) {
        res.write('<!DOCTYPE html>');
        res.write('<body>');
        res.write('<script>top.location = "' + LoginProvider.escape(originalUrl) + '";</script>');
        res.write('</body>');
        res.write('</html>');
        res.end();
    }
    static async validateToken(rawAssertion: string, parent: Span): Promise<User> {
        const span: Span = Logger.otel.startSubSpan("LoginProvider.validateToken", parent);
        return new Promise<User>((resolve, reject) => {
            try {
                const options = {
                    publicKey: Buffer.from(Config.signing_crt, "base64").toString("ascii")
                }
                saml.validate(rawAssertion, options, async (err, profile) => {
                    try {
                        if (err) { span?.recordException(err); return reject(err); }
                        const claims = profile.claims; // Array of user attributes;
                        const username = claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] ||
                            claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
                            claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"];

                        const user = await Logger.DBHelper.FindByUsername(username, null, span);
                        if (user) {
                            resolve(user);
                        } else {
                            span?.recordException("Unknown user");
                            reject("Unknown user");
                        }
                    } catch (error) {
                        span?.recordException(error);
                        reject(error);
                    } finally {
                        Logger.otel.endSpan(span);
                    }

                });
            } catch (error) {
                span?.recordException(error);
            } finally {
                Logger.otel.endSpan(span);
            }
        });
    }
    static async configure(app: express.Express, baseurl: string): Promise<void> {
        app.use(passport.initialize());
        app.use(passport.session());
        passport.serializeUser(async function (user: any, done: any): Promise<void> {
            const tuser: TokenUser = TokenUser.From(user);
            // await Auth.AddUser(tuser as any, tuser._id, "passport");
            done(null, user._id);
        });
        passport.deserializeUser(async function (userid: string, done: any): Promise<void> {
            if (NoderedUtil.IsNullEmpty(userid)) return done('missing userid', null);
            if (typeof userid !== 'string') userid = (userid as any)._id
            if (NoderedUtil.IsNullEmpty(userid)) return done('missing userid', null);
            const _user = await Logger.DBHelper.FindById(userid, null, null);
            if (_user == null) {
                done(null, null);
            } else {
                done(null, _user);
            }
            // const _user = await Auth.getUser(userid, "passport");
            // if (_user == null) {
            //     const user = await DBHelper.FindById(userid, null, null);
            //     if (user != null) {
            //         const tuser = TokenUser.From(user);
            //         await Auth.AddUser(tuser as any, tuser._id, "passport");
            //         done(null, tuser);
            //     } else {
            //         done(null, null);
            //     }

            // } else {
            //     done(null, _user);
            // }
        });

        app.use(function (req, res, next) {
            const origin: string = (req.headers.origin as any);
            if (NoderedUtil.IsNullEmpty(origin)) {
                res.header('Access-Control-Allow-Origin', '*');
            } else {
                res.header('Access-Control-Allow-Origin', origin);
            }
            res.header("Access-Control-Allow-Methods", "DELETE, POST, PUT, GET, OPTIONS");
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Access-Control-Allow-Headers, Authorization");
            res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
            res.header('Expires', '-1');
            res.header('Pragma', 'no-cache');
            if (req.originalUrl == "/oidc/me" && req.method == "OPTIONS") {
                res.send("ok");
            } else {
                next();
            }
        });
        app.get("/dashboardauth", async (req: any, res: any, next: any) => {
            const span: Span = (Config.otel_trace_dashboardauth ? Logger.otel.startSpan("LoginProvider.dashboardauth") : null);
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                if (req.user) {
                    const user: TokenUser = TokenUser.From(req.user);
                    span?.setAttribute("username", user.username);
                    if (user != null) {
                        const allowed = user.roles.filter(x => x.name == "dashboardusers" || x.name == "admins");
                        if (allowed.length > 0) {
                            if (Config.log_login_provider) Logger.instanse.info("dashboardauth: Authorized " + user.username + " for " + req.url);
                            return res.send({
                                status: "success",
                                display_status: "Success",
                                message: "Connection OK"
                            });
                        } else {
                            console.warn("dashboardauth: " + user.username + " is not member of 'dashboardusers' for " + req.url);
                        }
                    }
                }
                const authorization: string = req.headers.authorization;

                if (NoderedUtil.IsNullEmpty(authorization)) {
                    res.statusCode = 401;
                    res.setHeader('WWW-Authenticate', 'Basic realm="OpenFlow"');
                    res.end('Unauthorized');
                    return;
                }

                var user: User = await Logger.DBHelper.FindByAuthorization(authorization, null, span);
                if (user != null) {
                    const allowed = user.roles.filter(x => x.name == "dashboardusers" || x.name == "admins");
                    if (allowed.length > 0) {
                        return res.send({
                            status: "success",
                            display_status: "Success",
                            message: "Connection OK"
                        });
                    } else {
                        console.warn("dashboardauth: " + user.username + " is not member of 'dashboardusers' for " + req.url);
                    }
                }
                res.statusCode = 401;
                res.setHeader('WWW-Authenticate', 'Basic realm="OpenFlow"');
                res.end('Unauthorized');
                return;
            } catch (error) {
                span?.recordException(error);
                throw error;
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.get("/Signout", (req: any, res: any, next: any): void => {
            req.logout();
            const originalUrl: any = req.cookies.originalUrl;
            if (!NoderedUtil.IsNullEmpty(originalUrl)) {
                res.cookie("originalUrl", "", { expires: new Date(0) });
                LoginProvider.redirect(res, originalUrl);
            } else {
                res.redirect("/");
            }
        });
        app.get("/PassiveSignout", (req: any, res: any, next: any): void => {
            req.logout();
            const originalUrl: any = req.cookies.originalUrl;
            if (!NoderedUtil.IsNullEmpty(originalUrl)) {
                res.cookie("originalUrl", "", { expires: new Date(0) });
                LoginProvider.redirect(res, originalUrl);
            } else {
                res.redirect("/Login");
            }
        });
        await LoginProvider.RegisterProviders(app, baseurl);
        app.get("/user", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.user");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                res.setHeader("Content-Type", "application/json");
                if (req.user) {
                    const user: User = await Logger.DBHelper.FindById(req.user._id, undefined, span);
                    res.end(JSON.stringify(user));
                } else {
                    res.end(JSON.stringify({}));
                }
                res.end();
            } catch (error) {
                span?.recordException(error);
                throw error;
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.get("/jwt", (req: any, res: any, next: any): void => {
            const span: Span = Logger.otel.startSpan("LoginProvider.jwt");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                res.setHeader("Content-Type", "application/json");
                if (req.user) {
                    const user: TokenUser = TokenUser.From(req.user);
                    span?.setAttribute("username", user.username);
                    res.end(JSON.stringify({ jwt: Crypt.createToken(user, Config.shorttoken_expires_in), user: user }));
                } else {
                    res.end(JSON.stringify({ jwt: "" }));
                }
                res.end();
            } catch (error) {
                span?.recordException(error);
                console.error(error.message ? error.message : error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.get("/jwtlong", (req: any, res: any, next: any): void => {
            const span: Span = Logger.otel.startSpan("LoginProvider.jwtlong");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                res.setHeader("Content-Type", "application/json");
                if (req.user) {
                    const user: TokenUser = TokenUser.From(req.user);
                    span?.setAttribute("username", user.username);
                    if (!(user.validated == true) && Config.validate_user_form != "") {
                        res.end(JSON.stringify({ jwt: "" }));
                    } else {
                        res.end(JSON.stringify({ jwt: Crypt.createToken(user, Config.longtoken_expires_in), user: user }));
                    }
                } else {
                    res.end(JSON.stringify({ jwt: "" }));
                }
                res.end();
            } catch (error) {
                span?.recordException(error);
                console.error(error.message ? error.message : error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.post("/jwt", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.jwt");
            // logger.debug("/jwt " + !(req.user == null));
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                const rawAssertion = req.body.token;
                const user: User = await LoginProvider.validateToken(rawAssertion, span);
                const tuser: TokenUser = TokenUser.From(user);
                span?.setAttribute("username", user.username);
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ jwt: Crypt.createToken(tuser, Config.shorttoken_expires_in) }));
            } catch (error) {
                span?.recordException(error);
                console.error(error.message ? error.message : error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.get("/config", (req: any, res: any, next: any): void => {
            const span: Span = Logger.otel.startSpan("LoginProvider.config");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                let _url = Config.basewsurl();
                if (!NoderedUtil.IsNullEmpty(Config.api_ws_url)) _url = Config.api_ws_url;
                if (!_url.endsWith("/")) _url += "/";
                if (req.user) {
                    const user: TokenUser = TokenUser.From(req.user);
                    span?.setAttribute("username", user.username);
                }
                let nodered_domain_schema = Config.nodered_domain_schema;
                if (NoderedUtil.IsNullEmpty(nodered_domain_schema)) {
                    nodered_domain_schema = "$nodered_id$." + Config.domain;
                }
                const res2 = {
                    wshost: _url,
                    wsurl: _url,
                    domain: Config.domain,
                    auto_create_users: Config.auto_create_users,
                    allow_personal_nodered: Config.allow_personal_nodered,
                    auto_create_personal_nodered_group: Config.auto_create_personal_nodered_group,
                    auto_create_personal_noderedapi_group: Config.auto_create_personal_noderedapi_group,
                    namespace: Config.namespace,
                    nodered_domain_schema: nodered_domain_schema,
                    websocket_package_size: Config.websocket_package_size,
                    version: Config.version,
                    stripe_api_key: Config.stripe_api_key,
                    getting_started_url: Config.getting_started_url,
                    validate_user_form: Config.validate_user_form,
                    supports_watch: Config.supports_watch,
                    nodered_images: Config.nodered_images,
                    amqp_enabled_exchange: Config.amqp_enabled_exchange,
                    multi_tenant: Config.multi_tenant,
                    enable_entity_restriction: Config.enable_entity_restriction,
                    enable_web_tours: Config.enable_web_tours,
                    collections_with_text_index: DatabaseConnection.collections_with_text_index,
                    timeseries_collections: DatabaseConnection.timeseries_collections,
                    ping_clients_interval: Config.ping_clients_interval,
                    validlicense: Logger.License.validlicense
                }
                res.end(JSON.stringify(res2));
            } catch (error) {
                span?.recordException(error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.post("/AddTokenRequest", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.login");
            try {
                const key = req.body.key;
                let exists: TokenRequest = await Logger.DBHelper.FindRequestTokenID(key, span);
                if (!NoderedUtil.IsNullUndefinded(exists)) return res.status(500).send({ message: "Illegal key" });
                await Logger.DBHelper.AdddRequestTokenID(key, {}, span);
                res.status(200).send({ message: "ok" });
            } catch (error) {
                span?.recordException(error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.get("/GetTokenRequest", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.login");
            try {
                const key = req.query.key;
                let exists: TokenRequest = null;
                exists = await Logger.DBHelper.FindRequestTokenID(key, span);
                if (NoderedUtil.IsNullUndefinded(exists)) {
                    res.status(200).send({ message: "Illegal key" });
                    return;
                }

                if (!NoderedUtil.IsNullEmpty(exists.jwt)) {
                    if (Config.validate_user_form != "") {
                        try {
                            var tuser = await await Crypt.verityToken(exists.jwt);
                            var user = await Logger.DBHelper.FindById(tuser._id, exists.jwt, span);
                            if (user.validated == true) {
                                await Logger.DBHelper.RemoveRequestTokenID(key, span);
                                res.status(200).send(Object.assign(exists, { message: "ok" }));

                            } else {
                                res.status(200).send({ message: "ok" });
                            }
                        } catch (error) {
                            Logger.instanse.error(error.message ? error.message : error);
                        }
                    } else {
                        res.status(200).send(Object.assign(exists, { message: "ok" }));
                        await Logger.DBHelper.RemoveRequestTokenID(key, span);
                    }
                } else {
                    res.status(200).send(Object.assign(exists, { message: "ok" }));
                }
            } catch (error) {
                Logger.instanse.error(error.message ? error.message : error);
                span?.recordException(error);
                try {
                    res.status(500).send({ message: error.message ? error.message : error });
                } catch (error) {
                }
            } finally {
                try {
                    res.end();
                } catch (error) {
                }
                Logger.otel.endSpan(span);
            }
        });
        app.get("/login", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.login");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                let key = req.query.key;
                if (NoderedUtil.IsNullEmpty(key) && !NoderedUtil.IsNullEmpty(req.cookies.requesttoken)) key = req.cookies.requesttoken;

                if (!NoderedUtil.IsNullEmpty(key)) {
                    if (req.user) {
                        const user: User = await Logger.DBHelper.FindById(req.user._id, undefined, span);
                        var exists: TokenRequest = await Logger.DBHelper.FindRequestTokenID(key, span);
                        if (!NoderedUtil.IsNullUndefinded(exists)) {
                            await Logger.DBHelper.AdddRequestTokenID(key, { jwt: Crypt.createToken(user, Config.longtoken_expires_in) }, span);
                            res.cookie("requesttoken", "", { expires: new Date(0) });
                        }
                    } else {
                        res.cookie("requesttoken", key, { maxAge: 36000, httpOnly: true });
                    }
                }
                if (!NoderedUtil.IsNullEmpty(req.query.key)) {
                    if (req.user) {
                        res.cookie("originalUrl", "", { expires: new Date(0) });
                        this.redirect(res, "/");
                    } else {
                        res.cookie("originalUrl", req.originalUrl, { maxAge: 900000, httpOnly: true });
                        this.redirect(res, "/login");
                    }
                }
                const originalUrl: any = req.cookies.originalUrl;
                const validateurl: any = req.cookies.validateurl;
                if (NoderedUtil.IsNullEmpty(originalUrl) && !req.originalUrl.startsWith("/login")) {
                    res.cookie("originalUrl", req.originalUrl, { maxAge: 900000, httpOnly: true });
                }
                if (!NoderedUtil.IsNullEmpty(validateurl)) {
                    if (req.user) {
                        const user: User = await Logger.DBHelper.FindById(req.user._id, undefined, span);
                        const tuser: TokenUser = TokenUser.From(user);
                        if (tuser.validated) {
                            Logger.DBHelper.DeleteKey("user" + tuser._id);
                        }
                        // req.session.passport.user.validated = tuser.validated;
                        if (!(tuser.validated == true) && Config.validate_user_form != "") {
                        } else {
                            res.cookie("validateurl", "", { expires: new Date(0) });
                            res.cookie("originalUrl", "", { expires: new Date(0) });
                            this.redirect(res, "/#" + validateurl);
                            return;
                        }
                    }
                }
                const file = path.join(__dirname, 'public', 'PassiveLogin.html');
                res.sendFile(file);
            } catch (error) {
                span?.recordException(error);
                console.error(error.message ? error.message : error);
                try {
                    return res.status(500).send({ message: error.message ? error.message : error });
                } catch (error) {
                }
            }
            Logger.otel.endSpan(span);
        });
        app.get("/validateuserform", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.validateuserform");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                res.setHeader("Content-Type", "application/json");
                if (NoderedUtil.IsNullEmpty(Config.validate_user_form)) {
                    res.end(JSON.stringify({}));
                    res.end();
                    Logger.otel.endSpan(span);
                    return;
                }
                var forms = await Config.db.query<Base>({ query: { _id: Config.validate_user_form, _type: "form" }, top: 1, collectionname: "forms", jwt: Crypt.rootToken() }, span);
                if (forms.length == 1) {
                    res.end(JSON.stringify(forms[0]));
                    res.end();
                    Logger.otel.endSpan(span);
                    return;
                }
                if (Config.log_login_provider) Logger.instanse.info("validate_user_form " + Config.validate_user_form + " does not exists!");
                Config.validate_user_form = "";
                res.end(JSON.stringify({}));
                res.end();
            } catch (error) {
                span?.recordException(error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
            return;
        });
        app.post("/validateuserform", async (req: any, res) => {
            const span: Span = Logger.otel.startSpan("LoginProvider.postvalidateuserform");
            // logger.debug("/validateuserform " + !(req.user == null));
            res.setHeader("Content-Type", "application/json");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                if (req.user) {
                    if (req.body && req.body.data) {
                        const tuser: TokenUser = TokenUser.From(req.user);
                        delete req.body.data._id;
                        delete req.body.data.username;
                        delete req.body.data.disabled;
                        delete req.body.data.type;
                        delete req.body.data.roles;
                        delete req.body.data.submit;
                        req.body.data.validated = true;
                        delete req.body.data.federationids;
                        delete req.body.data.nodered;
                        delete req.body.data.billing;
                        delete req.body.data.clientagent;
                        delete req.body.data.clientversion;
                        const UpdateDoc: any = { "$set": {} };
                        const keys = Object.keys(req.body.data);
                        keys.forEach(key => {
                            if (key.startsWith("_")) {
                            } else if (key.indexOf("$") > -1) {
                            } else {
                                UpdateDoc.$set[key] = req.body.data[key];
                            }
                        });
                        var res2 = await Config.db._UpdateOne({ "_id": tuser._id }, UpdateDoc, "users", 1, false, Crypt.rootToken(), span);
                        const user: TokenUser = Object.assign(tuser, req.body.data);
                        Logger.DBHelper.DeleteKey("user" + user._id);
                        // req.session.passport.user.validated = true;
                        // wewfefwewe


                        if (!(user.validated == true) && Config.validate_user_form != "") {
                            res.end(JSON.stringify({ jwt: "" }));
                        } else {
                            res.end(JSON.stringify({ jwt: Crypt.createToken(user, Config.longtoken_expires_in), user: user }));
                        }
                    }
                } else {
                    res.end(JSON.stringify({ jwt: "" }));
                }
            } catch (error) {
                span?.recordException(error);
                console.error(error);
                return res.status(500).send({ message: error.message ? error.message : error });
            }
            Logger.otel.endSpan(span);
            res.end();
        });

        app.get("/loginproviders", async (req: any, res: any, next: any): Promise<void> => {
            const span: Span = Logger.otel.startSpan("LoginProvider.loginproviders");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                const result: Provider[] = await Logger.DBHelper.GetProviders(span);
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(result));
                res.end();
            } catch (error) {
                span?.recordException(error);
                console.error(error.message ? error.message : error);
                Logger.otel.endSpan(span);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        app.get("/download/:id", async (req, res) => {
            const span: Span = Logger.otel.startSpan("LoginProvider.download");
            try {
                span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                let user: TokenUser = null;
                let jwt: string = null;
                const authHeader = req.headers.authorization;
                if (authHeader) {
                    user = await Crypt.verityToken(authHeader);
                    jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                }
                else if (req.user) {
                    user = TokenUser.From(req.user as any);
                    jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                }
                if (user == null) {
                    return res.status(404).send({ message: 'Route ' + req.url + ' Not found.' });
                }

                const id = req.params.id;
                const rows = await Config.db.query({ query: { _id: safeObjectID(id) }, top: 1, collectionname: "files", jwt }, span);
                if (rows == null || rows.length != 1) { return res.status(404).send({ message: 'id ' + id + ' Not found.' }); }
                const file = rows[0] as any;

                const bucket = new GridFSBucket(Config.db.db);
                let downloadStream = bucket.openDownloadStream(safeObjectID(id));
                res.set('Content-Type', file.contentType);
                res.set('Content-Disposition', 'attachment; filename="' + file.filename + '"');
                res.set('Content-Length', file.length);
                downloadStream.on("error", function (err) {
                    res.end();
                });
                downloadStream.pipe(res);
            } catch (error) {
                span?.recordException(error);
                return res.status(500).send({ message: error.message ? error.message : error });
            } finally {
                Logger.otel.endSpan(span);
            }
        });
        try {
            const storage = new GridFsStorage({
                db: Config.db,
                file: (req, file) => {
                    return new Promise((resolve, reject) => {
                        crypto.randomBytes(16, async (err, buf) => {
                            if (err) {
                                return reject(err);
                            }
                            // const filename = buf.toString('hex') + path.extname(file.originalname);
                            const filename = file.originalname;
                            const fileInfo = {
                                filename: filename,
                                metadata: new Base()
                            };
                            let user: TokenUser = null;
                            let jwt: string = null;
                            const authHeader = req.headers.authorization;
                            if (authHeader) {
                                user = await Crypt.verityToken(authHeader);
                                jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                            }
                            else if (req.user) {
                                user = TokenUser.From(req.user as any);
                                jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                            }
                            const { query, headers } = req;

                            fileInfo.metadata.name = filename;
                            (fileInfo.metadata as any).filename = filename;
                            (fileInfo.metadata as any).path = "";
                            (fileInfo.metadata as any).uniquename = query.uniquename;
                            (fileInfo.metadata as any).form = query.form;
                            (fileInfo.metadata as any).project = query.project;
                            (fileInfo.metadata as any).baseurl = query.baseUrl;
                            fileInfo.metadata._acl = [];
                            fileInfo.metadata._createdby = user.name;
                            fileInfo.metadata._createdbyid = user._id;
                            fileInfo.metadata._created = new Date(new Date().toISOString());
                            fileInfo.metadata._modifiedby = user.name;
                            fileInfo.metadata._modifiedbyid = user._id;
                            fileInfo.metadata._modified = fileInfo.metadata._created;

                            const keys = Object.keys(query);
                            for (let i = 0; i < keys.length; i++) {
                                fileInfo.metadata[keys[i]] = query[keys[i]];
                            }
                            Base.addRight(fileInfo.metadata, user._id, user.name, [Rights.full_control]);
                            Base.addRight(fileInfo.metadata, WellknownIds.filestore_admins, "filestore admins", [Rights.full_control]);
                            Base.addRight(fileInfo.metadata, WellknownIds.filestore_users, "filestore users", [Rights.read]);
                            // Fix acl
                            fileInfo.metadata._acl.forEach((a, index) => {
                                if (typeof a.rights === "string") {
                                    fileInfo.metadata._acl[index].rights = (new Binary(Buffer.from(a.rights, "base64"), 0) as any);
                                }
                            });
                            resolve(fileInfo);
                        });
                    });
                },
            });
            const upload = multer({ //multer settings for single upload
                storage: storage,
                limits: {
                    fileSize: (1000000 * Config.upload_max_filesize_mb) // 25MB
                }
            }).any();
            app.delete("/upload", async (req: any, res: any, next: any): Promise<void> => {
                const span: Span = Logger.otel.startSpan("LoginProvider.upload");
                try {
                    span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                    let user: TokenUser = null;
                    let jwt: string = null;
                    const authHeader = req.headers.authorization;
                    if (authHeader) {
                        user = await Crypt.verityToken(authHeader);
                        jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                    }
                    else if (req.user) {
                        user = TokenUser.From(req.user as any);
                        jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                    }
                    if (user == null) {
                        return res.status(404).send({ message: 'Route ' + req.url + ' Not found.' });
                    }
                    const _query = req.query;
                    let uniquename: string = _query.uniquename;
                    let query: any = {};
                    if (!NoderedUtil.IsNullEmpty(uniquename)) {
                        if (Array.isArray(uniquename)) uniquename = uniquename.join("_");
                        if (uniquename.indexOf('/') > -1) uniquename = uniquename.substr(0, uniquename.indexOf('/'));
                        query = { "metadata.uniquename": uniquename };
                    }

                    const arr = await Config.db.query({ query, top: 1, orderby: { "uploadDate": -1 }, collectionname: "files", jwt }, span);
                    if (arr.length > 0) {
                        await Config.db.DeleteOne(arr[0]._id, "files", jwt, span);
                    }
                    res.send({
                        status: "success",
                        display_status: "Success",
                        message: uniquename + " deleted"
                    });
                } catch (error) {
                    span?.recordException(error);
                    console.error(error);
                    return res.status(500).send({ message: error.message ? error.message : error });
                } finally {
                    Logger.otel.endSpan(span);
                }

            });
            app.get("/upload", async (req: any, res: any, next: any): Promise<void> => {
                const span: Span = Logger.otel.startSpan("LoginProvider.upload");
                try {
                    span?.setAttribute("remoteip", LoginProvider.remoteip(req));
                    let user: TokenUser = null;
                    let jwt: string = null;
                    const authHeader = req.headers.authorization;
                    if (authHeader) {
                        user = await Crypt.verityToken(authHeader);
                        jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                    }
                    else if (req.user) {
                        user = TokenUser.From(req.user as any);
                        jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                    }
                    if (user == null) {
                        return res.status(404).send({ message: 'Route ' + req.url + ' Not found.' });
                    }
                    const _query = req.query;
                    let uniquename: string = _query.uniquename;
                    let query: any = {};
                    if (!NoderedUtil.IsNullEmpty(uniquename)) {
                        if (Array.isArray(uniquename)) uniquename = uniquename.join("_");
                        if (uniquename.indexOf('/') > -1) uniquename = uniquename.substr(0, uniquename.indexOf('/'));
                        query = { "metadata.uniquename": uniquename };
                    }

                    const arr = await Config.db.query({ query, top: 1, orderby: { "uploadDate": -1 }, collectionname: "files", jwt }, span);

                    const id = arr[0]._id;
                    const rows = await Config.db.query({ query: { _id: safeObjectID(id) }, top: 1, collectionname: "files", jwt }, span);
                    if (rows == null || rows.length != 1) { return res.status(404).send({ message: 'id ' + id + ' Not found.' }); }
                    const file = rows[0] as any;

                    const bucket = new GridFSBucket(Config.db.db);
                    let downloadStream = bucket.openDownloadStream(safeObjectID(id));
                    res.set('Content-Type', file.contentType);
                    res.set('Content-Disposition', 'attachment; filename="' + file.filename + '"');
                    res.set('Content-Length', file.length);
                    downloadStream.on("error", function (err) {
                        res.end();
                    });
                    downloadStream.pipe(res);
                    return;
                } catch (error) {
                    span?.recordException(error);
                    return res.status(500).send({ message: error.message ? error.message : error });
                } finally {
                    Logger.otel.endSpan(span);
                }
            });
            app.post("/upload", async (req, res) => {
                let user: TokenUser = null;
                let jwt: string = null;
                const authHeader = req.headers.authorization;
                if (authHeader) {
                    user = await Crypt.verityToken(authHeader);
                    jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                }
                else if (req.user) {
                    user = TokenUser.From(req.user as any);
                    jwt = Crypt.createToken(user, Config.downloadtoken_expires_in);
                }
                if (user == null) {
                    return res.status(404).send({ message: 'Route ' + req.url + ' Not found.' });
                }

                upload(req, res, function (err) {
                    if (err) {
                        res.json({ error_code: 1, err_desc: err });
                        return;
                    }
                    LoginProvider.redirect(res, req.headers.referer);
                    // res.json({ error_code: 0, err_desc: null });
                });
            });
        } catch (error) {
            console.error(error.message ? error.message : error);
        }

    }
    static async RegisterProviders(app: express.Express, baseurl: string) {
        const span: Span = Logger.otel.startSpan("LoginProvider.RegisterProviders");
        try {
            let hasLocal: boolean = false;
            var providers = await Logger.DBHelper.GetProviders(span);
            if (providers.length === 0) { hasLocal = true; }
            providers.forEach(async (provider) => {
                try {
                    if (NoderedUtil.IsNullUndefinded(LoginProvider._providers[provider.id])) {
                        if (provider.provider === "saml") {
                            const metadata: any = await Config.parse_federation_metadata(provider.saml_federation_metadata);
                            LoginProvider._providers[provider.id] =
                                LoginProvider.CreateSAMLStrategy(app, provider.id, metadata.cert,
                                    metadata.identityProviderUrl, provider.issuer, baseurl);
                        }
                        if (provider.provider === "google") {
                            LoginProvider._providers[provider.id] =
                                LoginProvider.CreateGoogleStrategy(app, provider.id, provider.consumerKey, provider.consumerSecret, baseurl);
                        }
                    }
                    if (provider.provider === "local") { hasLocal = true; }
                } catch (error) {
                    console.error(error.message ? error.message : error);
                }
            });
            if (hasLocal === true) {
                if (NoderedUtil.IsNullUndefinded(LoginProvider._providers.local)) {
                    LoginProvider._providers.local = LoginProvider.CreateLocalStrategy(app, baseurl);
                }
            }
            const keys = Object.keys(LoginProvider._providers);
            for (var i = 0; i < keys.length; i++) {
                let key = keys[i];
                var exists = providers.filter(x => x.id == key || (key == 'local' && x.provider == 'local'));
                if (exists.length == 0) {
                    if (Config.log_login_provider) Logger.instanse.info("[loginprovider] Removing passport strategy " + key);
                    passport.unuse(key);
                }
            }
        } catch (error) {
            span?.recordException(error);
            throw error;
        } finally {
            Logger.otel.endSpan(span);
        }
    }
    static CreateGoogleStrategy(app: express.Express, key: string, consumerKey: string, consumerSecret: string, baseurl: string): any {
        if (Config.log_login_provider) Logger.instanse.info("[loginprovider] Adding new google strategy " + key);
        const options: googleauthstrategyoptions = new googleauthstrategyoptions();
        options.clientID = consumerKey;
        options.clientSecret = consumerSecret;
        options.callbackURL = url.parse(baseurl).protocol + "//" + url.parse(baseurl).host + "/" + key + "/";
        (options as any).passReqToCallback = true;
        options.verify = (LoginProvider.googleverify).bind(this);
        const strategy: passport.Strategy = new GoogleStrategy.Strategy(options, options.verify);
        passport.use(key, strategy);
        strategy.name = key;
        app.use("/" + key,
            express.urlencoded({ extended: false }),
            passport.authenticate(key, { failureRedirect: "/" + key, failureFlash: true }),
            function (req: any, res: any): void {
                const originalUrl: any = req.cookies.originalUrl;
                res.cookie("provider", key, { maxAge: 900000, httpOnly: true });
                if (!NoderedUtil.IsNullEmpty(originalUrl)) {
                    res.cookie("originalUrl", "", { expires: new Date(0) });
                    LoginProvider.redirect(res, originalUrl);
                } else {
                    res.redirect("/");
                }
            }
        );
        return strategy;
    }

    // tslint:disable-next-line: max-line-length
    static CreateSAMLStrategy(app: express.Express, key: string, cert: string, singin_url: string, issuer: string, baseurl: string): passport.Strategy {
        if (Config.log_login_provider) Logger.instanse.info("[loginprovider] Adding new SAML strategy " + key);
        const options: samlauthstrategyoptions = new samlauthstrategyoptions();
        (options as any).passReqToCallback = true;
        options.entryPoint = singin_url;
        options.cert = cert;
        options.issuer = issuer;
        options.callbackUrl = url.parse(baseurl).protocol + "//" + url.parse(baseurl).host + "/" + key + "/";
        options.verify = (LoginProvider.samlverify).bind(this);
        const SamlStrategy = require('passport-saml').Strategy
        const strategy: passport.Strategy = new SamlStrategy(options, options.verify);
        passport.use(key, strategy);
        strategy.name = key;

        // app.get("/" + key + "/FederationMetadata/2007-06/FederationMetadata.xml",
        //     wsfed.metadata({
        //         cert: Buffer.from(Config.signing_crt, "base64").toString("ascii"),
        //         issuer: issuer
        //     }));
        const CertPEM = Buffer.from(Config.signing_crt, "base64").toString("ascii").replace(/(-----(BEGIN|END) CERTIFICATE-----|\n)/g, '');
        app.get("/" + key + "/FederationMetadata/2007-06/FederationMetadata.xml",
            (req: express.Request, res: express.Response, next: express.NextFunction) => {
                res.set("Content-Type", "text/xml");
                res.send(`
            <EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="` + issuer + `">
            <RoleDescriptor xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706" xsi:type="fed:SecurityTokenServiceType" protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" 
            ServiceDisplayName="` + issuer + `">
            <KeyDescriptor use="signing">
            <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
            <X509Data>
            <X509Certificate>` + CertPEM + `</X509Certificate>
            </X509Data>
            </KeyInfo>
            </KeyDescriptor>
            <fed:TokenTypesOffered>
            <fed:TokenType Uri="urn:oasis:names:tc:SAML:2.0:assertion"/>
            <fed:TokenType Uri="urn:oasis:names:tc:SAML:1.0:assertion"/>
            </fed:TokenTypesOffered>
            <fed:ClaimTypesOffered>
            <auth:ClaimType xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706" Uri="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" Optional="true">
            <auth:DisplayName>E-Mail Address</auth:DisplayName>
            <auth:Description>The e-mail address of the user</auth:Description>
            </auth:ClaimType>
            <auth:ClaimType xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706" Uri="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname" Optional="true">
            <auth:DisplayName>Given Name</auth:DisplayName>
            <auth:Description>The given name of the user</auth:Description>
            </auth:ClaimType>
            <auth:ClaimType xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706" Uri="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name" Optional="true">
            <auth:DisplayName>Name</auth:DisplayName>
            <auth:Description>The unique name of the user</auth:Description>
            </auth:ClaimType>
            <auth:ClaimType xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706" Uri="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname" Optional="true">
            <auth:DisplayName>Surname</auth:DisplayName>
            <auth:Description>The surname of the user</auth:Description>
            </auth:ClaimType>
            <auth:ClaimType xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706" Uri="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier" Optional="true">
            <auth:DisplayName>Name ID</auth:DisplayName>
            <auth:Description>The SAML name identifier of the user</auth:Description>
            </auth:ClaimType>
            </fed:ClaimTypesOffered>originalUrl
            <fed:PassiveRequestorEndpoint>
            <EndpointReference xmlns="http://www.w3.org/2005/08/addressing">
            <Address>` + options.callbackUrl + `</Address>
            </EndpointReference>
            </fed:PassiveRequestorEndpoint>
            </RoleDescriptor>
            </EntityDescriptor>
            `);
            });
        app.use("/" + key,
            express.urlencoded({ extended: false }),
            passport.authenticate(key, { failureRedirect: "/" + key, failureFlash: true }),
            function (req: any, res: any): void {
                const originalUrl: any = req.cookies.originalUrl;
                res.cookie("provider", key, { maxAge: 900000, httpOnly: true });
                if (!NoderedUtil.IsNullEmpty(originalUrl)) {
                    res.cookie("originalUrl", "", { expires: new Date(0) });
                    LoginProvider.redirect(res, originalUrl);
                } else {
                    res.redirect("/");
                }
            }
        );

        return strategy;
    }

    static CreateLocalStrategy(app: express.Express, baseurl: string): passport.Strategy {
        const strategy: passport.Strategy = new LocalStrategy({ passReqToCallback: true }, async (req: any, username: string, password: string, done: any): Promise<void> => {
            if (Config.log_login_provider) Logger.instanse.info("[loginprovider] Adding new local strategy");
            const span: Span = Logger.otel.startSpan("LoginProvider.LocalLogin");
            try {
                let remoteip: string = "";
                if (!NoderedUtil.IsNullUndefinded(req)) {
                    remoteip = LoginProvider.remoteip(req);
                }
                span?.setAttribute("remoteip", remoteip);
                if (username !== null && username != undefined) { username = username.toLowerCase(); }
                let user: User = null;
                var providers = await Logger.DBHelper.GetProviders(span);
                if (providers.length === 0) {
                    user = await Logger.DBHelper.FindByUsername(username, null, span);
                    if (user == null) {
                        let createUser: boolean = Config.auto_create_users;
                        if (!createUser) {
                            return done(null, false);
                        }
                        user = new User(); user.name = username; user.username = username;
                        await Crypt.SetPassword(user, password, span);
                        const jwt: string = Crypt.rootToken();
                        user = await Logger.DBHelper.EnsureUser(jwt, user.name, user.username, null, password, span);

                        const admins: Role = await Logger.DBHelper.FindRoleByName("admins", span);
                        admins.AddMember(user);
                        await Logger.DBHelper.Save(admins, Crypt.rootToken(), span)
                    } else {
                        if (user.disabled) {
                            await Audit.LoginFailed(username, "weblogin", "local", remoteip, "browser", "unknown", span);
                            done("Disabled user " + username, null);
                            return;
                        }
                        if (!(await Crypt.ValidatePassword(user, password, span))) {
                            await Audit.LoginFailed(username, "weblogin", "local", remoteip, "browser", "unknown", span);
                            return done(null, false);
                        }
                    }
                    await Audit.LoginSuccess(TokenUser.From(user), "weblogin", "local", remoteip, "browser", "unknown", span);
                    const provider: Provider = new Provider(); provider.provider = "local"; provider.name = "Local";
                    const result = await Config.db.InsertOne(provider, "config", 0, false, Crypt.rootToken(), span);
                    await Logger.DBHelper.ClearProviders();
                    const tuser: TokenUser = TokenUser.From(user);
                    return done(null, tuser);
                }
                user = await Logger.DBHelper.FindByUsername(username, null, span);
                if (NoderedUtil.IsNullUndefinded(user)) {
                    let createUser: boolean = Config.auto_create_users;
                    if (!createUser) {
                        return done(null, false);
                    }
                    user = await Logger.DBHelper.EnsureUser(Crypt.rootToken(), username, username, null, password, span);
                } else {
                    if (user.disabled) {
                        await Audit.LoginFailed(username, "weblogin", "local", remoteip, "browser", "unknown", span);
                        done("Disabled user " + username, null);
                        return;
                    }
                    if (!(await Crypt.ValidatePassword(user, password, span))) {
                        await Audit.LoginFailed(username, "weblogin", "local", remoteip, "browser", "unknown", span);
                        return done(null, false);
                    }
                }
                const tuser: TokenUser = TokenUser.From(user);
                await Audit.LoginSuccess(tuser, "weblogin", "local", remoteip, "browser", "unknown", span);
                // tuser.roles.splice(40, tuser.roles.length)
                Logger.otel.endSpan(span);
                return done(null, tuser);
            } catch (error) {
                span?.recordException(error);
                Logger.otel.endSpan(span);
                console.error(error.message ? error.message : error);
                done(error.message ? error.message : error);
            }
        });
        passport.use("local", strategy);
        app.use("/local",
            express.urlencoded({ extended: false }),
            function (req: any, res: any, next: any): void {
                passport.authenticate("local", function (err, user, info) {
                    let originalUrl: any = req.cookies.originalUrl;
                    if (err) {
                        Logger.instanse.error(err);
                    }
                    if (!err && user) {
                        req.logIn(user, function (err: any) {
                            if (err) {
                                if (Config.log_login_provider) Logger.instanse.info("req.logIn failed");
                                Logger.instanse.error(err);
                                return next(err);
                            }
                            if (!NoderedUtil.IsNullEmpty(originalUrl)) {
                                try {
                                    res.cookie("originalUrl", "", { expires: new Date(0) });
                                    LoginProvider.redirect(res, originalUrl);
                                    if (Config.log_login_provider) Logger.instanse.debug("redirect: " + originalUrl);
                                    return;
                                } catch (error) {
                                    console.error(error.message ? error.message : error);
                                }
                            } else {
                                res.redirect("/");
                                return next();
                            }
                        });
                        return;
                    }
                    if (!NoderedUtil.IsNullEmpty(originalUrl)) {
                        if (originalUrl.indexOf("?") == -1) {
                            originalUrl = originalUrl + "?error=1"
                        } else if (originalUrl.indexOf("error=1") == -1) {
                            originalUrl = originalUrl + "&error=1"
                        }
                        try {
                            res.cookie("originalUrl", "", { expires: new Date(0) });
                            if (Config.log_login_provider) Logger.instanse.debug("redirect: " + originalUrl);
                            LoginProvider.redirect(res, originalUrl);
                        } catch (error) {
                            console.error(error.message ? error.message : error);
                        }
                    } else {
                        try {
                            res.redirect("/");
                            return next();
                        } catch (error) {
                            console.error(error.message ? error.message : error);
                        }
                    }
                })(req, res, next);
            }
        );

        return strategy;
    }
    static async samlverify(req: any, profile: any, done: IVerifyFunction): Promise<void> {
        const span: Span = Logger.otel.startSpan("LoginProvider.samlverify");
        try {
            let username: string = profile.username;
            if (NoderedUtil.IsNullEmpty(username)) username = profile.nameID;
            if (!NoderedUtil.IsNullEmpty(username)) { username = username.toLowerCase(); }
            if (Config.log_login_provider) Logger.instanse.debug("verify: " + username);
            let _user: User = await Logger.DBHelper.FindByUsernameOrFederationid(username, span);
            let remoteip: string = "";
            if (!NoderedUtil.IsNullUndefinded(req)) {
                remoteip = LoginProvider.remoteip(req);
            }
            span?.setAttribute("remoteip", remoteip);

            if (NoderedUtil.IsNullUndefinded(_user)) {
                let createUser: boolean = Config.auto_create_users;
                if (Config.auto_create_domains.map(x => username.endsWith(x)).length > 0) { createUser = true; }
                if (createUser) {
                    _user = new User(); _user.name = profile.name;
                    if (!NoderedUtil.IsNullEmpty(profile["http://schemas.microsoft.com/identity/claims/displayname"])) {
                        _user.name = profile["http://schemas.microsoft.com/identity/claims/displayname"];
                    }
                    if (!NoderedUtil.IsNullEmpty(profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"])) {
                        _user.name = profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];
                    }
                    _user.username = username;
                    if (!NoderedUtil.IsNullEmpty(profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobile"])) {
                        (_user as any).mobile = profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobile"];
                    }
                    if (NoderedUtil.IsNullEmpty(_user.name)) { done("Cannot add new user, name is empty, please add displayname to claims", null); return; }
                    const jwt: string = Crypt.rootToken();
                    _user = await Logger.DBHelper.EnsureUser(jwt, _user.name, _user.username, null, null, span);
                }
            } else {
                if (!NoderedUtil.IsNullUndefinded(_user)) {
                    if (!NoderedUtil.IsNullEmpty(profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobile"])) {
                        (_user as any).mobile = profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/mobile"];
                    }
                    const jwt: string = Crypt.rootToken();
                    await Logger.DBHelper.Save(_user, jwt, span);
                }
            }

            if (!NoderedUtil.IsNullUndefinded(_user)) {
                if (!NoderedUtil.IsNullEmpty(profile["http://schemas.xmlsoap.org/claims/Group"])) {
                    const jwt: string = Crypt.rootToken();
                    const strroles: string[] = profile["http://schemas.xmlsoap.org/claims/Group"];
                    for (let i = 0; i < strroles.length; i++) {
                        const role: Role = await Logger.DBHelper.FindRoleByName(strroles[i], span);
                        if (!NoderedUtil.IsNullUndefinded(role)) {
                            role.AddMember(_user);
                            await Logger.DBHelper.Save(role, jwt, span);
                        }
                    }
                    _user = await Logger.DBHelper.DecorateWithRoles(_user, span);
                }
            }

            if (NoderedUtil.IsNullUndefinded(_user)) {
                await Audit.LoginFailed(username, "weblogin", "saml", remoteip, "samlverify", "unknown", span);
                done("unknown user " + username, null);
                return;
            }
            if (_user.disabled) {
                await Audit.LoginFailed(username, "weblogin", "saml", remoteip, "samlverify", "unknown", span);
                done("Disabled user " + username, null);
                return;
            }

            const tuser: TokenUser = TokenUser.From(_user);
            await Audit.LoginSuccess(tuser, "weblogin", "saml", remoteip, "samlverify", "unknown", span);
            Logger.otel.endSpan(span);
            done(null, tuser);
        } catch (error) {
            span?.recordException(error);
        }
        Logger.otel.endSpan(span);
    }
    static async googleverify(req: any, token: string, tokenSecret: string, profile: any, done: IVerifyFunction): Promise<void> {
        const span: Span = Logger.otel.startSpan("LoginProvider.googleverify");
        try {
            if (profile.emails) {
                const email: any = profile.emails[0];
                profile.username = email.value;
            }
            let remoteip: string = "";
            if (!NoderedUtil.IsNullUndefinded(req)) {
                remoteip = LoginProvider.remoteip(req);
            }
            span?.setAttribute("remoteip", remoteip);
            let username: string = profile.username;
            if (NoderedUtil.IsNullEmpty(username)) username = profile.nameID;
            if (!NoderedUtil.IsNullEmpty(username)) { username = username.toLowerCase(); }
            if (Config.log_login_provider) Logger.instanse.debug("verify: " + username);
            let _user: User = await Logger.DBHelper.FindByUsernameOrFederationid(username, span);
            if (NoderedUtil.IsNullUndefinded(_user)) {
                let createUser: boolean = Config.auto_create_users;
                if (Config.auto_create_domains.map(x => username.endsWith(x)).length > 0) { createUser = true; }
                if (createUser) {
                    const jwt: string = Crypt.rootToken();
                    _user = new User(); _user.name = profile.name;
                    if (!NoderedUtil.IsNullEmpty(profile.displayName)) { _user.name = profile.displayName; }
                    _user.username = username;
                    (_user as any).mobile = profile.mobile;
                    if (NoderedUtil.IsNullEmpty(_user.name)) { done("Cannot add new user, name is empty.", null); return; }
                    _user = await Logger.DBHelper.EnsureUser(jwt, _user.name, _user.username, null, null, span);
                }
            }
            if (NoderedUtil.IsNullUndefinded(_user)) {
                await Audit.LoginFailed(username, "weblogin", "google", remoteip, "googleverify", "unknown", span);
                done("unknown user " + username, null); return;
            }
            if (_user.disabled) {
                await Audit.LoginFailed(username, "weblogin", "google", remoteip, "googleverify", "unknown", span);
                done("Disabled user " + username, null);
                return;
            }
            const tuser: TokenUser = TokenUser.From(_user);
            await Audit.LoginSuccess(tuser, "weblogin", "google", remoteip, "googleverify", "unknown", span);
            done(null, tuser);
        } catch (error) {
            span?.recordException(error);
        }
        Logger.otel.endSpan(span);
    }


}