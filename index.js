const express = require('express');
const Tesseract = require('tesseract.js');
const database = require('./models/database');
const decryptfun = require('./config/decrypt');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Enable JSON body parsing

//const imageocr = require('./models/ocrdata');
/**
 * @typedef {object} Appauthmodel
 * @property {string} Orderid
 * @property {string} Passcode
 */

app.post('/ocr', async (req, res) => {
  try {
    
    const { base64Image } = req.body;

    if (!base64Image) {
      return res.status(400).send('Missing base64Image in the request body.');
    }

    // Remove the data URL prefix if it exists (e.g., 'data:image/png;base64,')
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

    // Create a Buffer from the base64 string
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Perform OCR using Tesseract.js
    const { data: { text } } = await Tesseract.recognize(
      imageBuffer,
      'eng' // Language code for English
    );

    res.json({ text });
  } catch (error) {
    console.error('Error during OCR:', error);
    res.status(500).send('Error processing the image for OCR.');
  }
});

app.post('/authenticate', async (req, res) => {

  try 
  {
    const { EncryptedData } = req.body;

    if(!EncryptedData) 
    {
      return res.status(400).json({ success: false, data: 'Missing EncryptedData in the request body' });
    }

    const decryptedJson = decryptfun.decryptData(EncryptedData);

    if(!decryptedJson) 
    {
      return res.status(400).json({ success: false, data: 'Failed to decrypt data' });
    }
    /** @type {Appauthmodel} */
    let auth;
    try {
      auth = JSON.parse(decryptedJson);
      if (!auth.Orderid || !auth.Passcode) {
        return res.status(400).json({ success: false, data: 'Invalid decrypted data format' });
      }
    } catch (error) {
      console.error('Error parsing decrypted JSON:', error);
      return res.status(400).json({ success: false, data: 'Invalid decrypted JSON' });
    }

    let connection;
    try {

      connection = await database.pool.getConnection();
      const sql = 
      `
        SELECT DO.CompanyId,DO.TransportId,DO.Total_quantity,DO.Quantity,DO.Rate,DO.Grade,DO.wclcompid,DO.Date,DO.LR,C.CompName AS CompanyName,WC.CompName AS WCLCompanyName , CONCAT(WC.Comp_Add,' ',WC.Comp_City,' ', WC.Comp_State,' ',WC.Comp_Pincode) AS Wclcompanyaddress, CONCAT(C.Comp_Add,' ',C.Comp_City,' ', C.Comp_State,' ',C.Comp_Pincode) AS Companyaddress FROM DeliveryOrder DO 
        INNER JOIN Company C ON C.CompID = DO.CompanyId 
        INNER JOIN WCL_Company WC ON WC.CompID = DO.wclcompid 
        WHERE DO.Orderno = ? AND DO.Passcode = ?;
      `;

      const [rows] = await connection.execute(sql, [auth.Orderid, auth.Passcode]);

      if (rows.length > 0) {
        const reader = rows[0];
        /** @type {import('./types/Displayedorder').Displayedmodel} */
        // reader.Date display only date and time in dd.mm.yyyy HH:MM  format
        reader.Date = new Date(reader.Date).toLocaleString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        //console.log("Reader:", reader.Date);
        const displayedorder = {
          CompanyId: parseInt(reader.CompanyId),
          TransportId: parseInt(reader.TransportId),
          Total_quantity: parseInt(reader.Total_quantity),
          Quantity: parseInt(reader.Quantity),
          Rate: reader.Rate,
          Grade: reader.Grade,
          Date: reader.Date,
          LR: reader.LR,
          FromCompany : {
            Wclcompanyname:reader.WCLCompanyName,
            Address:reader.Wclcompanyaddress
          },
          ToCompany : {
            Companyname:reader.CompanyName,
            Address:reader.Companyaddress 
          } 
        };
        res.json({ success: true, data: displayedorder });
      } else {
        res.json({ success: false, data: 'Failed to Authenticate' });
      }
    } catch (error) {
      console.error('Database query error:', error);
      res.status(500).json({ success: false, data: 'Database error' });
    } finally {
      if (connection) {
        connection.release();
      }
    }
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ success: false, data: 'Authentication process failed' });
  }
});

app.post('/uploadpermit', async (req, res) => {
  /** @type {import('./types/truck').Truckmodel} */
  const truckmodel = req.body;
  let connection;
    
  try {
    if (!truckmodel || !truckmodel.permit_receipt) {
      return res.status(400).send('No image data received.');
    }
    
    //console.log("Truck model data:", truckmodel);

    let base64String = truckmodel.permit_receipt;

    if (base64String.includes(',')) {
      base64String = base64String.split(',')[1];
    }

    const fileData = Buffer.from(base64String, 'base64');

    connection = await database.pool.getConnection();

    // Step 1: Check if record already exists with is_permit_uploaded = 'true'
    const [existingRows] = await connection.execute(
      `SELECT * FROM WCL_Truck WHERE orderid = ? AND transporterid = ? AND temp_truckno = ? AND is_permit_uploaded = 'true';`,
      [truckmodel.Orderid, truckmodel.Transporterid , truckmodel.temp_truckno]
    );

    let lastInsertId;
    //console.log("Existing rows:", existingRows);

    if (existingRows.length > 0) {
      // Step 2: UPDATE the existing record
      const updateSql = `UPDATE WCL_Truck SET permit_receipt = ? WHERE orderid = ? AND temp_truckno = ? AND transporterid = ? `;
      await connection.execute(updateSql, [
        fileData,
        truckmodel.Orderid,
        truckmodel.temp_truckno,
        truckmodel.Transporterid
      ]);
      lastInsertId = existingRows[0].id; // Assuming you have an `id` column
    } else {
      // Step 3: INSERT new record
      const insertSql = `INSERT INTO WCL_Truck (transporterid, permit_receipt, orderid, is_permit_uploaded, temp_truckno) VALUES (?, ?, ?, ?, ?)`;
      const [insertResult] = await connection.execute(insertSql, [
        truckmodel.Transporterid,
        fileData,
        truckmodel.Orderid,
        "true",
        truckmodel.temp_truckno
      ]);

      const [rows] = await connection.execute('SELECT LAST_INSERT_ID() as lastId');
      lastInsertId = rows[0].lastId;
    }

    const Permitmodel = {
      Permitno: "",
      Orderno: truckmodel.Orderid || "",
      Truckno: truckmodel.temp_truckno || ""
    };

    res.json({ success: true, data: Permitmodel, id: lastInsertId });

  } catch (error) {
    console.error('Error uploading permit:', error);
    res.status(500).json({ success: false, data: 'Failed to upload' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});


app.put('/Addpermitno', async (req, res) => {

  /** @type {object} */
  const permitdata = req.body;
  let connection;
  try
  {

    if(!permitdata) 
    {
      return res.status(400).json({ success: false, Message: 'Missing permit data or lastid' });
    }

    connection = await database.pool.getConnection();
    const sql = `
      UPDATE WCL_Truck
      SET permitno=?,
          transportno=?,
          Net_weight=?
      WHERE orderid=? AND temp_truckno=? AND transporterid = ?
    `;

    const [result] = await connection.execute(sql,[
      permitdata.Permitno,
      permitdata.Transporterno,
      permitdata.netwt,
      permitdata.Orderno,
      permitdata.temp_truckno,
      permitdata.transporterid
    ]);

    if(result.affectedRows > 0) 
    {
      return res.json({ success: true, Message: 'Permit data updated' });
    }else 
    {
      return res.json({ success: false, Message: 'Failed to update permit data. Record not found or data is the same.' });
    }

  }catch(error) 
  {
    console.error('Error updating permit data:', error);
    return res.status(500).json({ success: false, Message: 'Failed to upload' });
  }finally 
  {
    if(connection) 
    {
      connection.release();
    }
  }
});

app.put('/UploadLRReciept', async (req, res) => {
  
  const orderid = req.body.orderid; // Try to get id from params, or body as a fallback
  const temp_truckno = req.body.temp_truckno;
  const transporterid = req.body.transporterid;
  const { lorryimage } = req.body;
  let connection;

  try {
   
    if (!lorryimage) {
      return res.status(404).json({ success: false, data: 'No image data received.' });
    }

    let base64String = lorryimage;
    if(base64String.includes(",")) 
    {
      base64String = base64String.split(',')[1]; // Extract only the Base64 part
    }

    // Check if orderid, temp_truckno, and transporterid are provided
    if (!orderid || !temp_truckno || !transporterid) {
      return res.status(400).json({ success: false, data: 'Missing orderid, temp_truckno or transporterid' });
    }

    const fileData = Buffer.from(base64String, 'base64');

    connection = await database.pool.getConnection();
    const sql = `
      UPDATE WCL_Truck
      SET lorry_receipt=?,is_lorry_uploaded = ?
      WHERE orderid=? AND temp_truckno=? AND transporterid = ?
    `;

    const [result] = await connection.execute(sql, [fileData, "true", orderid, temp_truckno, transporterid]);

    if (result.affectedRows > 0) {
      const Lorrymodel = {
        LRno: "",
        LRReceiptno: "",
        Grade: "",
        Orderno: "",
        Weight: ""
      };

      return res.json({ success: true, data: Lorrymodel });

    } else {

      return res.json({ success: false, data: 'Failed to upload. Record not found or data is the same.' });

    }

  } catch (error) {
    console.error('Error uploading lorry receipt:', error);
    return res.status(500).json({ success: false, data: 'Failed to upload' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.put('/Uploadwclchallan', async (req, res) => {

  const orderid = req.body.orderid; // Try to get id from params, or body as a fallback
  const temp_truckno = req.body.temp_truckno;
  const transporterid = req.body.transporterid;
  const { wclchallan } = req.body;
  let connection;

  try {
    if (!orderid || !temp_truckno) {
      return res.status(400).json({ success: false, data: 'Missing orderid or temp_truckno' });
    }
    if (!wclchallan) {
      return res.status(404).json({ success: false, data: 'No image data received.' });
    }

    let base64String = wclchallan;
    if (base64String.includes(",")) {
      base64String = base64String.split(',')[1]; // Extract only the Base64 part
    }
    const fileData = Buffer.from(base64String, 'base64');

    connection = await database.pool.getConnection();
    const sql = `
      UPDATE WCL_Truck
      SET wcl_challan=? , is_wclchallan_uploaded=?
      WHERE orderid=? AND temp_truckno=? AND transporterid = ?
    `;

    const [result] = await connection.execute(sql, [fileData, "true", orderid, temp_truckno, transporterid]);

    if (result.affectedRows > 0) {
      const wcldata = {
        Dchallanno: 0,
        Truckno: "",
        Balanceqty: "",
        Baseprice: "",
        Grossqty: "",
        Netqty: "",
        Tareqty: "",
        Doqty: "",
        progressiveqty: ""
      };
      return res.json({ success: true, data: wcldata });
    } else {
      return res.json({ success: false, data: 'Failed to upload. Record not found or data is the same.' });
    }

  } catch (error) {
    console.error('Error uploading WCL challan:', error);
    return res.status(500).json({ success: false, data: 'Failed to upload' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.put('/LRatfactory', async (req, res) => {

  const orderid = req.body.orderid; // Try to get id from params, or body as a fallback
  const temp_truckno = req.body.temp_truckno;
  const transporterid = req.body.transporterid;
  let { LRatfactory , LRatfactoryback } = req.body;
  let connection;

  try {

    if (!orderid || !temp_truckno) {
      return res.status(400).json({ success: false, data: 'Missing orderid or temp_truckno' });
    }

    if (!LRatfactory) {
      return res.status(404).json({ success: false, data: 'No image data received.' });
    }

    let base64String2;
    let fileData2= null;
    if (!LRatfactoryback) {
      LRatfactoryback = null;
    }else
    {
      base64String2 = LRatfactoryback;
      if(base64String2.includes(",")) 
      {
       base64String2 = base64String2.split(',')[1]; // Extract only the Base64 part
       fileData2 = Buffer.from(base64String2, 'base64');
      }
    }

    let base64String = LRatfactory;
    if(base64String.includes(",")) 
    {
      base64String = base64String.split(',')[1]; // Extract only the Base64 part
    }
  
    const fileData = Buffer.from(base64String, 'base64');

    connection = await database.pool.getConnection();
    const sql = `
      UPDATE WCL_Truck
      SET LRatfactory=? , LRatfactoryback=? , is_LRatfactory_uploaded=? , Isalluploaded=?
      WHERE orderid=? AND temp_truckno=? AND transporterid = ?
    `;

    const [result] = await connection.execute(sql, [fileData, fileData2,  "true", "true", orderid, temp_truckno, transporterid]);

    if (result.affectedRows > 0) {
      return res.json({ success: true, data: 'Receipt uploaded successfully' });
    } else {
      return res.json({ success: false, data: 'Failed to upload. Record not found or data is the same.' });
    }

  } catch (error) {
    console.error('Error uploading LR at factory:', error);
    return res.status(500).json({ success: false, data: 'Failed to upload' });
  } finally {
    if (connection) {
      connection.release();
    }
  }

});


app.put('/updatefrontlorry', async (req, res) => {
   
    const orderid = req.body.orderid; // Try to get id from params, or body as a fallback
    const temp_truckno = req.body.temp_truckno;
    const transporterid = req.body.transporterid;
    let { LRatfactory } = req.body;
    let connection;

    try {
      connection = await database.pool.getConnection();
      const sql = `
        UPDATE WCL_Truck
        SET LRatfactory=?
        WHERE orderid=? AND temp_truckno=? AND transporterid = ?
      `;

      const [result] = await connection.execute(sql, [LRatfactory, orderid, temp_truckno, transporterid]);

      if (result.affectedRows > 0) {
        return res.json({ success: true, data: 'LR at factory updated successfully' });
      } else {
        return res.json({ success: false, data: 'Failed to update. Record not found or data is the same.' });
      }

    } catch (error) {
    console.error('Error uploading LR at factory:', error);
    return res.status(500).json({ success: false, data: 'Failed to upload' });
    } finally {
     if (connection) {
      connection.release();
     }
    }


});

app.put('/updatebacklorry', async (req, res) => {
   const orderid = req.body.orderid;
   const temp_truckno = req.body.temp_truckno;
   const transporterid = req.body.transporterid;
   let { LRatfactoryback } = req.body;
   let connection;

   try {
     if (!orderid || !temp_truckno) {
       return res.status(400).json({ success: false, data: 'Missing orderid or temp_truckno' });
     }

     if (!LRatfactoryback) {
       return res.status(404).json({ success: false, data: 'No image data received.' });
     }

     let base64String2;
     let fileData2= null;
     if (!LRatfactoryback) {
       LRatfactoryback = null;
     }else
     {
       base64String2 = LRatfactoryback;
       if(base64String2.includes(",")) 
       {
        base64String2 = base64String2.split(',')[1]; // Extract only the Base64 part
        fileData2 = Buffer.from(base64String2, 'base64');
       }
     }

     connection = await database.pool.getConnection();
     const sql = `
       UPDATE WCL_Truck
       SET LRatfactoryback=?
       WHERE orderid=? AND temp_truckno=? AND transporterid = ?
     `;

     const [result] = await connection.execute(sql, [fileData2,orderid, temp_truckno, transporterid]);

     if (result.affectedRows > 0) 
     {
       return res.json({ success: true, data: 'Receipt uploaded successfully' });
     } else {
       return res.json({ success: false, data: 'Failed to upload. Record not found or data is the same.' });
     }

   } catch (error) 
   {
     console.error('Error uploading LR at factory back:', error);
     return res.status(500).json({ success: false, data: 'Failed to upload' });
   } finally 
   {
     if (connection) 
     {
       connection.release();
     }
   }

});


// Update Lorry Data
app.put('/updateLorryData', async (req, res) => {
  let connection;
  try {

    connection = await database.pool.getConnection();
    const { LRno, LRReceiptno, Grade, date, netWt, orderid , temp_truckno,  transporterid} = req.body;

   /* if(!LRno || !LRReceiptno || !Grade || !date ||!netWt || !orderid || !temp_truckno) 
    {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    } */

    const sql = `UPDATE WCL_Truck SET LRNO=?, LRreceiptno=?, procurementdate=?, Grade=?, Net_weight=? WHERE orderid=? AND temp_truckno=? AND transporterid = ?`;
    
    // Execute query
    const [result] = await connection.execute(sql, [LRno, LRReceiptno, date, Grade, netWt, orderid, temp_truckno , transporterid]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'No matching record found to update' });
    }

    res.json({ success: true, message: 'Lorry data updated successfully' });

  } catch (error) {
    console.error('Error updating lorry data:', error);
    res.status(500).json({ success: false, message: 'Failed to update lorry data' });

  }finally 
  {
    if(connection) connection.release(); // Ensure connection is always released
  }
});

app.put('/updateChallanData', async(req, res) => {
  let connection;
  try {

    connection = await database.pool.getConnection();
    
    const { Dchallanno, grossqty, tareqty, netqty, Doqty, Balanceqty, progressiveqty, Baseprice, orderid, temp_truckno , transporterid } = req.body;
    
    const sql = `UPDATE WCL_Truck 
                 SET dchallano=?, grossqty=?, tareqty=?, netqty=?, 
                     Doqty=?, Balanceqty=?, progressiveqty=?, Baseprice=? 
                 WHERE orderid=? AND temp_truckno=? AND transporterid = ?;`;

    const [result] = await connection.execute(sql, [Dchallanno, grossqty, tareqty, netqty, Doqty, Balanceqty, progressiveqty, Baseprice, orderid, temp_truckno , transporterid]);
    if(result.affectedRows > 0) 
    {
      res.json({ success: true, message: 'WCL Truck data updated successfully' });
    }else 
    {
      res.status(404).json({ success: false, message: 'No records updated. Check if ID exists.' });
    }
  }catch (error) {
    console.error('Error updating WCL Truck data:', error);
    res.status(500).json({ success: false, message: 'Failed to update WCL Truck data' });
  } finally {
    if (connection) connection.release(); // Release connection properly
  }
});

app.put('/updatePermitReceipt', async (req, res) => {
  let connection;
  try {
    connection = await database.pool.getConnection();
    
    const { orderid, temp_truckno, permitimage , transporterid} = req.body;

    if (!permitimage) {
      return res.status(400).json({ success: false, message: 'Missing required fields: id or permitimage' });
    }

    // Extract only the Base64 part if prefixed with 'data:image/png;base64,' etc.
    let base64String = permitimage.includes(',') ? permitimage.split(',')[1] : permitimage;
    const fileData = Buffer.from(base64String, 'base64');

    const sql = `UPDATE WCL_Truck SET permit_receipt=? WHERE orderid=? AND temp_truckno=? AND transporterid = ?;`;

    const [result] = await connection.execute(sql, [fileData, orderid, temp_truckno , transporterid]);

    if (result.affectedRows > 0) {
      res.json({ success: true, message: 'Permit receipt updated successfully' });
    } else {
      res.status(404).json({ success: false, message: 'No records updated. Check if ID exists.' });
    }
  } catch (error) {
    console.error('Error updating permit receipt:', error);
    res.status(500).json({ success: false, message: 'Failed to update permit receipt' });
  } finally {
    if (connection) connection.release(); // Release connection properly
  }
});

app.post('/Gettrucknos', async (req, res) => {

  let connection;
  try {

    connection = await database.pool.getConnection();
    const {id,transporterid} = req.body;
    const sql = "SELECT temp_truckno, is_permit_uploaded, Isalluploaded FROM WCL_Truck WHERE orderid=? AND transporterid=?;";
    const [rows] = await connection.execute(sql,[id , transporterid]);
    if (rows.length > 0) {
      res.json({ success: true, trucks: rows });
    } else {
      res.json({ success: false, message: "No trucks found" });
    }
  } catch (error) {
    console.error("Error fetching truck numbers:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve truck data" });
  } finally {
    if (connection) connection.release();
  }

});

app.post('/docstatus', async (req, res) =>{
    let connection;
    try {
      connection = await database.pool.getConnection();
      const { orderid, temp_truckno, transporterid } = req.body;
      const sql = "SELECT is_permit_uploaded,is_lorry_uploaded,is_wclchallan_uploaded,is_LRatfactory_uploaded FROM WCL_Truck WHERE orderid=? AND temp_truckno=? AND transporterid=?;";
      const [rows] = await connection.execute(sql,[orderid, temp_truckno, transporterid]);
      if (rows.length > 0) {
        res.json({ success: true, docstatus: rows });
      } else {
        res.json({ success: false, message: "No docstatus found" });
      }
    }catch(error) {
      console.error("Error fetching docstatus:", error);
      res.status(500).json({ success: false, message: "Failed to retrieve docstatus" });
    } finally {
      if (connection) connection.release();
    }
});

app.put('/revisedlorrydata', async(req, res) => {

  let connection;
  try{
    connection = await database.pool.getConnection();
     console.log("Request body:", req.body);
    const { LRno, LRReceiptno, Grade, date, netWt, orderid, temp_truckno, transporterid } = req.body;
    /*if(!LRno || !LRReceiptno || !Grade || !date ||!netWt || !orderid || temp_truckno || !transporterid) 
    {
      console.log("Missing fields in request body");
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }*/
    const sql = `UPDATE WCL_Truck SET LRNO=?, LRreceiptno=?, date=?, Grade=?, netwetatfactory=? WHERE orderid=? AND temp_truckno=? AND transporterid = ?`;
    // Execute query
    const [result] = await connection.execute(sql, [LRno, LRReceiptno, date, Grade, netWt, orderid, temp_truckno, transporterid]);
    //console.log("Result:", result);
    if(result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'No matching record found to update' });
    }
    res.json({ success: true, message: 'Lorry data updated successfully' });
  }catch(error) {
    console.error('Error updating lorry data:', error);
    res.status(500).json({ success: false, message: 'Failed to update lorry data' });
  }finally 
  {
    if(connection) connection.release(); // Ensure connection is always released
  }

});

app.post('/getPermitData',async (req, res) => {
  let connection;
  try {
    connection = await database.pool.getConnection();
    const { orderid, temp_truckno, transporterid } = req.body;
    const sql = "SELECT permitno,transportno,Net_weight,permit_receipt FROM WCL_Truck WHERE orderid=? AND temp_truckno=? AND transporterid=?;";
    const [rows] = await connection.execute(sql,[orderid, temp_truckno, transporterid]);
    if (rows.length > 0) {

      // Convert Buffer to Base64 string for permit_receipt
      const mimeType = 'image/png'; 
      rows.forEach(row => {
        if (row.permit_receipt) {
          row.permit_receipt = row.permit_receipt.toString('base64');
          row.permit_receipt = `data:${mimeType};base64,${row.permit_receipt}`;
        }
      });

      res.json({ success: true, Data: rows });

    } else {
      res.json({ success: false, message: "No permit data found" });
    }
  } catch (error) {
    console.error("Error fetching permit data:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve permit data" });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/getLorryData',async (req, res) => {
  let connection;
  try {
    connection = await database.pool.getConnection();
    const { orderid, temp_truckno, transporterid } = req.body;
    const sql = "SELECT LRNO, LRreceiptno, procurementdate, Grade, Net_weight, lorry_receipt FROM WCL_Truck WHERE orderid=? AND temp_truckno=? AND transporterid=?;";
    const [rows] = await connection.execute(sql,[orderid, temp_truckno, transporterid]);
    if (rows.length > 0) {

      // Convert Buffer to Base64 string for lorry_receipt
      const mimeType = 'image/png'; 
      rows.forEach(row => {
        if (row.lorry_receipt) {
          row.lorry_receipt = row.lorry_receipt.toString('base64');
          row.lorry_receipt = `data:${mimeType};base64,${row.lorry_receipt}`;
        }
        // Convert procurementdate to dd.mm.yyyy format
        if (row.procurementdate && typeof row.procurementdate === 'string') {
          const date = new Date(row.procurementdate);
          row.procurementdate = date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
        } else if (row.procurementdate && row.procurementdate instanceof Date) {
          row.procurementdate = row.procurementdate.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
        }
        
      });

      res.json({ success: true, Data: rows });

    } else {
      res.json({ success: false, message: "No lorry data found" });
    }
  } catch (error) {
    console.error("Error fetching lorry data:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve lorry data" });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/getChallanData',async (req, res) => {
  let connection;
  try {
    connection = await database.pool.getConnection();
    const { orderid, temp_truckno, transporterid } = req.body;
    const sql = "SELECT dchallano, grossqty, tareqty, netqty, Doqty, Balanceqty, progressiveqty, Baseprice, wcl_challan FROM WCL_Truck WHERE orderid=? AND temp_truckno=? AND transporterid=?;";
    const [rows] = await connection.execute(sql,[orderid, temp_truckno, transporterid]);
    if (rows.length > 0) {

      // Convert Buffer to Base64 string for wcl_challan
      const mimeType = 'image/png'; 
      rows.forEach(row => {
        if (row.wcl_challan) {
          row.wcl_challan = row.wcl_challan.toString('base64');
          row.wcl_challan = `data:${mimeType};base64,${row.wcl_challan}`;
        }
      });

      res.json({ success: true, Data: rows });

    } else {
      res.json({ success: false, message: "No challan data found" });
    }
  } catch (error) {
    console.error("Error fetching challan data:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve challan data" });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/getFactoryData',async (req, res) => {
  let connection;
  try {
    connection = await database.pool.getConnection();
    const { orderid, temp_truckno, transporterid } = req.body;
    const sql = "SELECT LRNO, LRreceiptno, date, Grade, netwetatfactory, LRatfactory, LRatfactoryback FROM WCL_Truck WHERE orderid=? AND temp_truckno=? AND transporterid=?;";
    const [rows] = await connection.execute(sql,[orderid, temp_truckno, transporterid]);
    if (rows.length > 0) {

      // Convert Buffer to Base64 string for LRatfactory
      const mimeType = 'image/png'; 
      rows.forEach(row => {

        if (row.LRatfactory) 
        {
          row.LRatfactory = row.LRatfactory.toString('base64');
          row.LRatfactory = `data:${mimeType};base64,${row.LRatfactory}`;
        }

        if (row.LRatfactoryback) 
        {
          row.LRatfactoryback = row.LRatfactoryback.toString('base64');
          row.LRatfactoryback = `data:${mimeType};base64,${row.LRatfactoryback}`;
        }

        // Convert procurementdate to dd.mm.yyyy format
        if (row.date && typeof row.date === 'string') {
          const date = new Date(row.date);
          row.date = date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
        } else if (row.date && row.date instanceof Date) {
          row.date = row.date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
        }

      });

      res.json({ success: true, Data: rows });

    } else {
      res.json({ success: false, message: "No factory data found" });
    }
  } catch (error) {
    console.error("Error fetching factory data:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve factory data" });
  } finally {
    if (connection) connection.release();
  }
});

app.get('/Getewaybill', async (req, res) => {

    const imagePath = path.join(__dirname, 'images/bill.png');
    fs.readFile(imagePath, (err, data) => {
    if(err)
    {
      console.error('Error reading image:', err);
      return res.status(500).json({ error: 'Failed to read image' });
    }
    const base64Image = data.toString('base64');
    const mimeType = 'image/png'; // since your file is bill.png
    const base64String = `data:${mimeType};base64,${base64Image}`;
    res.json({ Billimage: base64String });
    }); 
});

const port = process.env.PORT || 3000;

app.listen(port,() => {
  console.log("server is listening on port 3000");
});

