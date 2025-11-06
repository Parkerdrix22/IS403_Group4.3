require('dotenv').config();

const express = require("express");

const session = require("express-session");

let path = require("path");
let bodyParser = require("body-parser");

let app = express();

app.set("view engine", "ejs");

const port = process.env.PORT || 3000;

app.use(
    session(
        {
            secret: process.env.SESSION_SECRET || 'fallback-secret-key',
            resave: false,
            saveUninitialized: false,
        }
    )
);

const knex = require("knex")({
    client: "mysql2",
    connection: {
        host : process.env.DB_HOST || "52.91.152.147",
        user : process.env.DB_USER || "IS403",
        password : process.env.DB_PASSWORD || "admin123",
        database : process.env.DB_NAME || "sys",
        port : process.env.DB_PORT || 3306
    }
});

knex.select().from("users")

app.use(express.urlencoded({extended: true}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/login' || req.path === '/login') {
        return next();
    }
    
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.render("login", { error_message: "Please log in to access this page"});
    }      
});

app.get("/", (req, res) => {
    res.render("login");
});

app.get("/login", (req, res) => {
	res.render("login");
});

app.post("/login", (req, res) => {
	const { username, password } = req.body;
	const HARD_CODED_PASSWORD = process.env.HARDCODED_PASSWORD || 'secret123';

	if (password === HARD_CODED_PASSWORD) {
		req.session.isLoggedIn = true;
		req.session.username = username;
		return res.redirect("/dashboard");
	}

	return res.status(401).render("login", { error_message: "Invalid credentials" });
});

app.get("/test", (req, res) => {
    res.render("test");
});

app.get("/dashboard", (req, res) => {
	res.render("index");
});

app.get("/logout", (req, res) => {
	req.session.destroy(() => {
		res.redirect("/login");
	});
});

app.listen(port, () => {
    console.log("The server is listening");
});

