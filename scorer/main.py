import tomllib
import uvicorn

if __name__ == "__main__":
    with open("../config.toml", "rb") as f:
        cfg = tomllib.load(f)
    uvicorn.run("api:app", host="127.0.0.1", port=cfg["ports"]["scorer"], reload=False)
