# SiteSureLabs


cd backend
.venv/Scripts/activate
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8010

cd frontend
npm run dev



Database:
=========
- In powershell type this command, for mongodb

docker run -d `
  --name defectra-mongo `
  -p 27017:27017 `
  -v mongo_data:/data/db `
  mongo:7


Verify MongoDB is actually usable
---------------------------------

docker exec -it defectra-mongo mongosh
show dbs


